-- Uploads by the admin, straight from the app. Each function checks the caller is the admin.
create or replace function room_is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce(my_role() = 'admin', false) $$;

-- 1. Start a Salesforce export
create or replace function room_export_start(p_as_of date, p_rows int, p_deals int) returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint; begin
  if not room_is_admin() then raise exception 'Only the admin can upload'; end if;
  insert into exports(as_of, rows, deals, uploaded_by) values (p_as_of, p_rows, p_deals, my_name()) returning id into v;
  return v;
end $$;

-- 2. Load deals in chunks: new deals are added, known deals are updated
create or replace function room_export_deals(p_export bigint, p_deals jsonb) returns int language plpgsql security definer set search_path = public as $$
declare n int; begin
  if not room_is_admin() then raise exception 'Only the admin can upload'; end if;
  insert into deals(id, ref, owner, segment, region, value, band, stage, stage_num, prob, close, status, entered_stage, source, type, products, export_id)
  select x.id, x.ref, x.owner, x.segment, x.region, x.value, x.band, x.stage, x.stage_num, x.prob, x.close, x.status, x.entered_stage, x.source, x.type, coalesce(x.products, '{}'), p_export
  from jsonb_to_recordset(p_deals) as x(id text, ref text, owner text, segment text, region text, value numeric, band text, stage text, stage_num int, prob numeric, close date, status text, entered_stage date, source text, type text, products text[])
  on conflict (id) do update set owner = excluded.owner, segment = excluded.segment, region = excluded.region, value = excluded.value, band = excluded.band,
    stage = excluded.stage, stage_num = excluded.stage_num, prob = excluded.prob, close = excluded.close, status = excluded.status,
    entered_stage = excluded.entered_stage, source = excluded.source, type = excluded.type, products = excluded.products, export_id = excluded.export_id;
  get diagnostics n = row_count; return n;
end $$;

-- 3. Finish: save the facts, add any new reps, open the next review
create or replace function room_export_finish(p_export bigint, p_facts jsonb, p_review date) returns json language plpgsql security definer set search_path = public as $$
declare e exports; r jsonb; added int := 0; begin
  if not room_is_admin() then raise exception 'Only the admin can upload'; end if;
  select * into e from exports where id = p_export;
  insert into brain_outputs(brain, kind, person, as_of, body) values ('deal', 'facts', null, e.as_of, p_facts);
  for r in select value from jsonb_each(coalesce(p_facts->'reps', '{}')) loop
    if not exists (select 1 from people where name = r->>'owner') then
      insert into people(name, role, segment, region, team) values (r->>'owner', 'rep', r->>'segment', r->>'region', (r->>'segment') || ' ' || (r->>'region'));
      added := added + 1;
    end if;
  end loop;
  insert into reviews(date, export_id, window_from, window_to) values (p_review, p_export, e.as_of - 6, e.as_of)
  on conflict (date) do update set export_id = excluded.export_id, window_from = excluded.window_from, window_to = excluded.window_to;
  return json_build_object('as_of', e.as_of, 'review', p_review, 'new_reps', added);
end $$;

-- A review recording: the admin ticks who was in it
create or replace function room_add_transcript(p_date date, p_title text, p_people text[], p_raw text) returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid; begin
  if not room_is_admin() then raise exception 'Only the admin can upload'; end if;
  insert into transcripts(kind, date, team, title, people, source, raw) values ('review', p_date, null, p_title, p_people, 'upload', p_raw) returning id into v;
  return v;
end $$;

do $$ declare f text; begin
  foreach f in array array['room_is_admin()','room_export_start(date,int,int)','room_export_deals(bigint,jsonb)','room_export_finish(bigint,jsonb,date)','room_add_transcript(date,text,text[],text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
notify pgrst, 'reload schema';

-- Promises in a new review recording: what each person promised, and which open promises came up
create or replace function room_review_context(p_transcript uuid) returns json language sql stable as $$
  select json_build_object(
    'transcript', (select json_build_object('id', id, 'date', date, 'title', title, 'people', people, 'raw', raw) from transcripts where id = p_transcript),
    'open', (select coalesce(json_agg(json_build_object('id', p.id, 'by', p.by_person, 'made_on', p.made_on, 'promise', p.promise) order by p.made_on), '[]')
             from promises p, transcripts t where t.id = p_transcript and p.by_person = any(t.people) and p.status in ('open', 'unclear', 'not raised again') and p.made_on < t.date)) $$;

create or replace function room_save_review_promises(p_transcript uuid, p_made jsonb, p_checked jsonb) returns json language plpgsql as $$
declare t transcripts; x jsonb; a int := 0; b int := 0; begin
  select * into t from transcripts where id = p_transcript;
  for x in select * from jsonb_array_elements(coalesce(p_made, '[]')) loop
    if (x->>'by') = any(t.people) then
      insert into promises(made_on, made_in, by_person, promise, due, status, evidence) values (t.date, t.id, x->>'by', x->>'promise', case when x->>'due' ~ '^\d{4}-\d{2}-\d{2}$' then (x->>'due')::date end, 'open', x->>'quote'); a := a + 1;
    end if;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p_checked, '[]')) loop
    update promises set status = x->>'status', checked_on = t.date, evidence = x->>'quote' where id = (x->>'promise_id')::uuid and by_person = any(t.people); b := b + 1;
  end loop;
  update transcripts set extraction = coalesce(extraction, '{}'::jsonb) || jsonb_build_object('promises_made', p_made, 'promises_checked', p_checked) where id = p_transcript;
  return json_build_object('made', a, 'checked', b);
end $$;
revoke all on function room_review_context(uuid) from public, anon, authenticated;
revoke all on function room_save_review_promises(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function room_review_context(uuid) to service_role;
grant execute on function room_save_review_promises(uuid, jsonb, jsonb) to service_role;
notify pgrst, 'reload schema';

-- Everything the Briefer needs for a phone call (the server calls this, no login on a phone)
create or replace function room_brief_context() returns json language sql stable as $$
  with rv as (select * from reviews order by date desc limit 1)
  select json_build_object(
    'review', (select row_to_json(rv) from rv),
    'cards', (select coalesce(json_agg(json_build_object('grp', grp, 'headline', headline, 'number', number, 'body', body, 'move', move, 'person', person, 'why', why, 'rank', rank) order by rank desc), '[]') from cards where status = 'live' and grp is not null),
    'checked_in', (select coalesce(json_agg(distinct p), '[]') from transcripts t, unnest(t.people) p, rv where t.kind = 'checkin' and t.date >= rv.window_from),
    'fixes', (select count(*) from sf_edits where status = 'waiting'),
    'broken', (select count(*) from promises, rv where status = 'broken' and checked_on >= rv.window_from),
    'reps', (select count(*) from people where role = 'rep')) $$;
revoke all on function room_brief_context() from public, anon, authenticated;
grant execute on function room_brief_context() to service_role;
notify pgrst, 'reload schema';
