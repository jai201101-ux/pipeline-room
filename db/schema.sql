-- Pipeline Room: memory and logins. Paste the whole file into Supabase > SQL Editor > Run.
-- Safe to run more than once.

-- People who can log in. Role decides what they see.
create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  email text unique,
  role text not null default 'rep' check (role in ('rep', 'vp', 'admin')),
  segment text, region text, team text,
  created_at timestamptz default now()
);

-- Every Salesforce export that was uploaded
create table if not exists exports (
  id bigserial primary key,
  uploaded_at timestamptz default now(),
  as_of date, rows int, deals int, uploaded_by text
);

-- The current Salesforce picture, one row per deal
create table if not exists deals (
  id text primary key,
  ref text, owner text, segment text, region text,
  value numeric, band text, stage text, stage_num int, prob numeric,
  close date, status text, entered_stage date, source text, type text,
  products text[], export_id bigint references exports(id),
  updated_at timestamptz default now()
);
create index if not exists deals_owner on deals(owner);

-- Every recording: review meetings and app check-ins
create table if not exists transcripts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('review', 'checkin')),
  date date not null, team text, title text,
  people text[] default '{}',
  source text default 'upload' check (source in ('upload', 'metaview', 'app')),
  raw text, extraction jsonb,
  created_at timestamptz default now()
);

-- Every fact, dated and sourced. Nothing reaches a screen without one of these behind it.
create table if not exists events (
  id bigserial primary key,
  at date not null,
  source_kind text not null check (source_kind in ('salesforce', 'checkin', 'review', 'lens', 'system')),
  source_id text, person text, deal_id text,
  type text not null,
  text text not null, data jsonb,
  created_at timestamptz default now()
);
create index if not exists events_person on events(person);
create index if not exists events_deal on events(deal_id);

-- Promises made in check-ins and reviews, and whether they were kept
create table if not exists promises (
  id uuid primary key default gen_random_uuid(),
  made_on date not null, made_in uuid references transcripts(id),
  by_person text not null, promise text not null,
  deal_id text, due date,
  status text not null default 'open' check (status in ('open', 'kept', 'broken', 'not raised again', 'unclear')),
  checked_on date, evidence text,
  created_at timestamptz default now()
);
create index if not exists promises_person on promises(by_person);

-- Salesforce changes drafted from check-ins, waiting for the VP
create table if not exists sf_edits (
  id uuid primary key default gen_random_uuid(),
  deal_id text, owner text, field text, from_value text, to_value text,
  reason text, source_id uuid references transcripts(id),
  status text not null default 'waiting' check (status in ('waiting', 'approved', 'rejected')),
  decided_by text, decided_at timestamptz,
  created_at timestamptz default now()
);

-- The two lenses. Every edit is a new version, with who changed it and why.
create table if not exists lenses (
  id bigserial primary key,
  brain text not null check (brain in ('deal', 'coach')),
  version int not null, body text not null,
  changed_by text not null, change_note text,
  created_at timestamptz default now(),
  unique (brain, version)
);

-- What each brain wrote: rep lists, profiles, facts
create table if not exists brain_outputs (
  id bigserial primary key,
  brain text not null check (brain in ('deal', 'coach')),
  kind text not null, person text, as_of date,
  body jsonb not null,
  created_at timestamptz default now()
);
create index if not exists outputs_lookup on brain_outputs(brain, kind, person, created_at desc);

-- Cards on the screens
create table if not exists cards (
  id uuid primary key default gen_random_uuid(),
  brain text not null check (brain in ('deal', 'coach', 'system')),
  as_of date, kind text, person text,
  title text not null, body text, move text,
  refs text[] default '{}', evidence jsonb, action jsonb,
  status text not null default 'live' check (status in ('live', 'done', 'dismissed')),
  created_at timestamptz default now()
);

-- Conversations with each brain, and the lens changes they proposed
create table if not exists chats (
  id uuid primary key default gen_random_uuid(),
  brain text not null check (brain in ('deal', 'coach')),
  person text not null, messages jsonb not null default '[]',
  proposed_change text, change_status text default 'none' check (change_status in ('none', 'proposed', 'saved', 'discarded')),
  created_at timestamptz default now()
);

-- Who is logged in, by name and role
create or replace function my_name() returns text language sql stable security definer set search_path = public as
$$ select name from people where lower(email) = lower(auth.jwt() ->> 'email') limit 1 $$;
create or replace function my_role() returns text language sql stable security definer set search_path = public as
$$ select role from people where lower(email) = lower(auth.jwt() ->> 'email') limit 1 $$;
create or replace function is_lead() returns boolean language sql stable as
$$ select coalesce(my_role() in ('vp', 'admin'), false) $$;

-- Row security: the VP and admin see everything, a rep sees their own
do $$ declare t text; begin
  foreach t in array array['people','exports','deals','transcripts','events','promises','sf_edits','lenses','brain_outputs','cards','chats'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

drop policy if exists people_read on people;            create policy people_read on people for select to authenticated using (true);
drop policy if exists exports_read on exports;          create policy exports_read on exports for select to authenticated using (true);
drop policy if exists lenses_read on lenses;            create policy lenses_read on lenses for select to authenticated using (true);
drop policy if exists deals_read on deals;              create policy deals_read on deals for select to authenticated using (is_lead() or owner = my_name());
drop policy if exists transcripts_read on transcripts;  create policy transcripts_read on transcripts for select to authenticated using (is_lead() or my_name() = any(people));
drop policy if exists events_read on events;            create policy events_read on events for select to authenticated using (is_lead() or person = my_name());
drop policy if exists promises_read on promises;        create policy promises_read on promises for select to authenticated using (is_lead() or by_person = my_name());
drop policy if exists sf_read on sf_edits;              create policy sf_read on sf_edits for select to authenticated using (is_lead() or owner = my_name());
drop policy if exists sf_decide on sf_edits;            create policy sf_decide on sf_edits for update to authenticated using (is_lead()) with check (is_lead());
drop policy if exists outputs_read on brain_outputs;    create policy outputs_read on brain_outputs for select to authenticated using (is_lead() or person = my_name());
drop policy if exists cards_read on cards;              create policy cards_read on cards for select to authenticated using (is_lead() or person = my_name());
drop policy if exists cards_update on cards;            create policy cards_update on cards for update to authenticated using (is_lead()) with check (is_lead());
drop policy if exists chats_own on chats;               create policy chats_own on chats for all to authenticated using (person = my_name()) with check (person = my_name());
