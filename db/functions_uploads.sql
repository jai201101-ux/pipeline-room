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
