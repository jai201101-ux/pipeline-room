-- Pipeline Room v2 server functions. Applied by the server through admin_sql.
-- One function per action. Only the server key can call them.

-- The demo clock: "today" is the last day of the current review's check-in window
create or replace function room_today() returns date language sql stable as $$
  select coalesce((select window_to from reviews order by date desc limit 1), current_date) $$;

create or replace function room_person(p_email text) returns json language sql stable as $$
  select row_to_json(p) from people p where lower(p.email) = lower(p_email) limit 1 $$;

-- Check-in: start a draft and hand back what the scribe needs
create or replace function room_start_draft(p_person text, p_conv text) returns json language plpgsql as $$
declare v_id uuid; begin
  insert into checkin_drafts(person, conversation_id, status) values (p_person, p_conv, 'working')
  on conflict (conversation_id) do update set status = 'working', error = null returning id into v_id;
  return json_build_object(
    'draft_id', v_id, 'today', room_today(),
    'deals', (select coalesce(json_agg(json_build_object('id', id, 'ref', ref, 'value', value, 'stage', stage, 'close', close) order by value desc nulls last), '[]') from deals where owner = p_person and status = 'open'),
    'list', (select body from brain_outputs where brain = 'deal' and kind = 'rep_list' and person = p_person order by created_at desc limit 1),
    'open_promises', (select coalesce(json_agg(json_build_object('id', id, 'made_on', made_on, 'promise', promise) order by made_on desc), '[]') from (select * from promises where by_person = p_person and status in ('open', 'not raised again', 'unclear') order by made_on desc limit 8) x));
end $$;

create or replace function room_save_draft(p_id uuid, p_transcript text, p_draft jsonb, p_status text, p_error text) returns void language sql as $$
  update checkin_drafts set transcript = p_transcript, draft = p_draft, status = p_status, error = p_error where id = p_id $$;

-- Check-in: the rep sends what they kept. Everything is written here, in one go.
create or replace function room_commit_checkin(p_person text, p_draft uuid, p_keep jsonb) returns json language plpgsql as $$
declare d checkin_drafts; v_tr uuid; v_today date := room_today(); x jsonb; v_deal text; n int := 0;
begin
  select * into d from checkin_drafts where id = p_draft and person = p_person and status = 'draft';
  if d.id is null then raise exception 'No draft to send'; end if;
  insert into transcripts(kind, date, people, source, raw, extraction) values ('checkin', v_today, array[p_person], 'app', d.transcript, p_keep) returning id into v_tr;
  for x in select * from jsonb_array_elements(coalesce(p_keep->'deals', '[]')) loop
    select id into v_deal from deals where owner = p_person and ref = x->>'ref' limit 1;
    if v_deal is not null and nullif(x->>'client', '') is not null then update deals set client = x->>'client' where id = v_deal; end if;
    insert into events(at, source_kind, source_id, person, deal_id, type, text, data) values (v_today, 'checkin', v_tr::text, p_person, v_deal, 'deal_update', coalesce(x->>'client', 'A deal') || ': ' || (x->>'line'), x);
    n := n + 1;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p_keep->'sf_edits', '[]')) loop
    select id into v_deal from deals where owner = p_person and ref = x->>'ref' limit 1;
    insert into sf_edits(deal_id, owner, field, to_value, reason, source_id) values (v_deal, p_person, x->>'field', x->>'to', x->>'line', v_tr);
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p_keep->'promises_made', '[]')) loop
    select id into v_deal from deals where owner = p_person and ref = x->>'ref' limit 1;
    insert into promises(made_on, made_in, by_person, promise, deal_id, due, status, evidence) values (v_today, v_tr, p_person, x->>'promise', v_deal, nullif(x->>'due', '')::date, 'open', x->>'quote');
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p_keep->'promises_checked', '[]')) loop
    update promises set status = x->>'status', checked_on = v_today, evidence = x->>'quote' where id = (x->>'promise_id')::uuid and by_person = p_person;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p_keep->'for_mark', '[]')) loop
    select id into v_deal from deals where owner = p_person and ref = x->>'ref' limit 1;
    insert into events(at, source_kind, source_id, person, deal_id, type, text, data) values (v_today, 'checkin', v_tr::text, p_person, v_deal, 'ask_mark', x->>'headline', x);
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p_keep->'not_covered', '[]')) loop
    insert into events(at, source_kind, source_id, person, type, text) values (v_today, 'checkin', v_tr::text, p_person, 'not_covered', 'Not covered in check-in: deal ' || (x #>> '{}'));
  end loop;
  update checkin_drafts set status = 'sent', sent_at = now() where id = p_draft;
  return json_build_object('ok', true, 'transcript_id', v_tr, 'deals', n);
end $$;

-- Coaching brain: everything on file for one person, oldest first
create or replace function room_coach_context(p_person text) returns json language sql stable as $$
  select json_build_object(
    'rules', (select coalesce(json_agg(json_build_object('text', text, 'source', source, 'author', author) order by id), '[]') from rules where brain = 'coach' and status = 'active'),
    'transcripts', (select coalesce(json_agg(json_build_object('date', date, 'kind', kind, 'title', title, 'raw', raw) order by date), '[]') from transcripts where p_person = any(people))) $$;

create or replace function room_save_output(p_brain text, p_kind text, p_person text, p_body jsonb) returns void language sql as $$
  insert into brain_outputs(brain, kind, person, as_of, body) values (p_brain, p_kind, p_person, room_today(), p_body) $$;

-- Today: everything the card builders need
create or replace function room_today_context() returns json language sql stable as $$
  select json_build_object(
    'today', room_today(),
    'review', (select row_to_json(r) from reviews r order by date desc limit 1),
    'facts', (select body from brain_outputs where brain = 'deal' and kind = 'facts' order by created_at desc limit 1),
    'deal_rules', (select coalesce(json_agg(json_build_object('text', text, 'source', source, 'author', author) order by id), '[]') from rules where brain = 'deal' and status = 'active'),
    'coach_rules', (select coalesce(json_agg(json_build_object('text', text, 'source', source, 'author', author) order by id), '[]') from rules where brain = 'coach' and status = 'active'),
    'lists', (select coalesce(json_agg(body), '[]') from (select distinct on (person) body from brain_outputs where brain = 'deal' and kind = 'rep_list' order by person, created_at desc) l),
    'profiles', (select coalesce(json_agg(body), '[]') from (select distinct on (person) body from brain_outputs where brain = 'coach' and kind = 'profile' order by person, created_at desc) p),
    'reactions', (select coalesce(json_agg(json_build_object('kind', x.kind, 'reason', x.reason, 'topic', c.why->>'topic', 'headline', c.headline, 'brain', c.brain) order by x.created_at desc), '[]') from reactions x join cards c on c.id = x.card_id),
    'sf_waiting', (select coalesce(json_agg(json_build_object('id', s.id, 'owner', s.owner, 'reason', s.reason, 'created_at', s.created_at)), '[]') from sf_edits s where s.status = 'waiting'),
    'asks', (select coalesce(json_agg(json_build_object('id', e.id, 'person', e.person, 'headline', e.text, 'quote', e.data->>'quote', 'date', e.at)), '[]') from events e where e.type = 'ask_mark' and coalesce((e.data->>'done')::boolean, false) = false),
    'clients', (select coalesce(json_object_agg(id, client), '{}') from deals where client is not null),
    'version', (select coalesce(max(version), 1) from thinking_versions)) $$;

-- Today: replace the live v2 cards with a fresh set
create or replace function room_save_today(p_cards jsonb) returns int language plpgsql as $$
declare x jsonb; n int := 0; v int := (select coalesce(max(version), 1) from thinking_versions);
begin
  update cards set status = 'dismissed' where status = 'live';
  for x in select * from jsonb_array_elements(p_cards) loop
    insert into cards(brain, as_of, kind, person, title, headline, number, body, move, refs, why, action, grp, rank, review_id, thinking_version, status)
    values (case x->>'grp' when 'coach' then 'coach' when 'ask' then 'deal' else 'system' end, room_today(), x->>'grp', x->>'person', x->>'headline', x->>'headline', x->>'number', x->>'body', x->>'move',
      coalesce(array(select jsonb_array_elements_text(coalesce(x->'refs', '[]'))), '{}'), jsonb_build_object('lines', x->'why', 'rows', x->'rows', 'topic', x->>'topic'), x->'action', x->>'grp', (x->>'rank')::numeric,
      (select id from reviews order by date desc limit 1), v, 'live');
    n := n + 1;
  end loop;
  return n;
end $$;

-- Deal brain: what it needs to rebuild every rep's list
create or replace function room_deal_context() returns json language sql stable as $$
  select json_build_object(
    'facts', (select body from brain_outputs where brain = 'deal' and kind = 'facts' order by created_at desc limit 1),
    'rules', (select coalesce(json_agg(json_build_object('text', text, 'source', source, 'author', author) order by id), '[]') from rules where brain = 'deal' and status = 'active'),
    'clients', (select coalesce(json_object_agg(id, client), '{}') from deals where client is not null),
    'news', (select coalesce(json_object_agg(person, items), '{}') from (select person, json_agg(json_build_object('at', at, 'text', text) order by at) items from events where source_kind = 'checkin' and type in ('deal_update', 'not_covered') group by person) n)) $$;

-- Trainers
create or replace function room_start_session(p_brain text, p_person text, p_conv text) returns json language plpgsql as $$
declare v_id uuid; begin
  insert into training_sessions(brain, person, conversation_id) values (p_brain, p_person, p_conv)
  on conflict (conversation_id) do update set status = 'working', error = null returning id into v_id;
  return json_build_object('session_id', v_id,
    'rules', (select coalesce(json_agg(json_build_object('n', rn, 'id', id, 'text', text, 'source', source, 'author', author) order by rn), '[]') from (select row_number() over (order by id) rn, * from rules where brain = p_brain and status = 'active') r));
end $$;

create or replace function room_save_proposal(p_id uuid, p_transcript text, p_proposal jsonb, p_status text, p_error text) returns void language sql as $$
  update training_sessions set transcript = p_transcript, proposal = p_proposal, status = p_status, error = p_error where id = p_id $$;

-- Deploy: new rules go live as a new version of the thinking model
create or replace function room_deploy(p_session uuid, p_person text) returns json language plpgsql as $$
declare s training_sessions; v int; x jsonb; old_id bigint; n int := 0;
begin
  select * into s from training_sessions where id = p_session and status = 'proposed';
  if s.id is null then raise exception 'Nothing to deploy'; end if;
  v := (select coalesce(max(version), 1) from thinking_versions) + 1;
  for x in select * from jsonb_array_elements(coalesce(s.proposal->'rules', '[]')) loop
    if (x->>'replaces') is not null then
      select id into old_id from (select row_number() over (order by id) rn, id from rules where brain = s.brain and status = 'active') r where rn = (x->>'replaces')::int;
      update rules set status = 'retired', to_version = v where id = old_id;
    end if;
    insert into rules(brain, text, source, author, said, from_version) values (s.brain, x->>'text', 'person', p_person, x->>'said', v);
    n := n + 1;
  end loop;
  insert into thinking_versions(version, deployed_by, summary, changes) values (v, p_person, n || ' new ' || case when s.brain = 'deal' then 'deal' else 'coaching' end || ' rule' || case when n = 1 then '' else 's' end, s.proposal);
  update training_sessions set status = 'deployed', decided_at = now() where id = p_session;
  return json_build_object('version', v, 'brain', s.brain, 'rules', n);
end $$;

-- Only the server may call these
do $$ declare f text; begin
  foreach f in array array['room_today()','room_person(text)','room_start_draft(text,text)','room_save_draft(uuid,text,jsonb,text,text)','room_commit_checkin(text,uuid,jsonb)','room_coach_context(text)','room_save_output(text,text,text,jsonb)','room_today_context()','room_save_today(jsonb)','room_deal_context()','room_start_session(text,text,text)','room_save_proposal(uuid,text,jsonb,text,text)','room_deploy(uuid,text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
