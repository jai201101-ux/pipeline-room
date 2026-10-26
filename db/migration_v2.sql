-- Pipeline Room v2. Paste into Supabase > SQL Editor > Run. Safe to run more than once.

-- Lets the server apply future changes itself, so you never paste SQL again.
-- Only the secret server key can call it. Logged-in people cannot.
create or replace function admin_sql(q text) returns void language plpgsql security definer set search_path = public as $$ begin execute q; end $$;
revoke all on function admin_sql(text) from public, anon, authenticated;
grant execute on function admin_sql(text) to service_role;

-- Deals get the client name once a rep says it
alter table deals add column if not exists client text;

-- One weekly review: everything belongs to one
create table if not exists reviews (
  id bigserial primary key,
  date date not null unique,
  export_id bigint references exports(id),
  window_from date, window_to date,
  created_at timestamptz default now()
);

-- The thinking model: every deployed version is kept
create table if not exists thinking_versions (
  id bigserial primary key,
  version int not null unique,
  deployed_by text not null,
  summary text,
  changes jsonb,
  created_at timestamptz default now()
);

-- One rule per row. Source says where it came from.
create table if not exists rules (
  id bigserial primary key,
  brain text not null check (brain in ('deal', 'coach')),
  text text not null,
  source text not null check (source in ('data', 'person', 'reaction')),
  author text not null,
  said text,
  status text not null default 'active' check (status in ('active', 'retired')),
  from_version int, to_version int,
  created_at timestamptz default now()
);

-- Mark's reactions to cards
create table if not exists reactions (
  id bigserial primary key,
  card_id uuid references cards(id) on delete cascade,
  person text not null,
  kind text not null check (kind in ('useful', 'not_useful', 'done')),
  reason text,
  created_at timestamptz default now()
);

-- What the scribe heard, waiting for the rep to confirm
create table if not exists checkin_drafts (
  id uuid primary key default gen_random_uuid(),
  person text not null,
  conversation_id text unique,
  status text not null default 'working' check (status in ('working', 'draft', 'sent', 'discarded', 'failed')),
  transcript text, draft jsonb, error text,
  created_at timestamptz default now(), sent_at timestamptz
);

-- Training sessions with the Analyst and the Mentor
create table if not exists training_sessions (
  id uuid primary key default gen_random_uuid(),
  brain text not null check (brain in ('deal', 'coach')),
  person text not null,
  conversation_id text unique,
  status text not null default 'working' check (status in ('working', 'proposed', 'deployed', 'discarded', 'failed')),
  transcript text, proposal jsonb, error text,
  created_at timestamptz default now(), decided_at timestamptz
);

-- Cards v2: group, headline, number, one action, reasons behind Why?
alter table cards add column if not exists grp text check (grp in ('decide', 'ask', 'coach'));
alter table cards add column if not exists headline text;
alter table cards add column if not exists number text;
alter table cards add column if not exists why jsonb;
alter table cards add column if not exists rank numeric;
alter table cards add column if not exists review_id bigint references reviews(id);
alter table cards add column if not exists thinking_version int;

-- Jobs the app asks the server to do (the server picks them up)
create table if not exists jobs (
  id bigserial primary key,
  kind text not null,
  payload jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  error text,
  created_at timestamptz default now(), finished_at timestamptz
);

-- Row security for the new tables
do $$ declare t text; begin
  foreach t in array array['reviews','thinking_versions','rules','reactions','checkin_drafts','training_sessions','jobs'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

drop policy if exists reviews_read on reviews;        create policy reviews_read on reviews for select to authenticated using (true);
drop policy if exists versions_read on thinking_versions; create policy versions_read on thinking_versions for select to authenticated using (true);
drop policy if exists rules_read on rules;            create policy rules_read on rules for select to authenticated using (true);
drop policy if exists reactions_lead on reactions;    create policy reactions_lead on reactions for all to authenticated using (is_lead()) with check (is_lead() and person = my_name());
drop policy if exists drafts_own on checkin_drafts;   create policy drafts_own on checkin_drafts for select to authenticated using (is_lead() or person = my_name());
drop policy if exists drafts_update on checkin_drafts; create policy drafts_update on checkin_drafts for update to authenticated using (person = my_name()) with check (person = my_name());
drop policy if exists sessions_lead on training_sessions; create policy sessions_lead on training_sessions for select to authenticated using (is_lead());
drop policy if exists sessions_decide on training_sessions; create policy sessions_decide on training_sessions for update to authenticated using (is_lead()) with check (is_lead());
drop policy if exists jobs_read on jobs;              create policy jobs_read on jobs for select to authenticated using (is_lead());
