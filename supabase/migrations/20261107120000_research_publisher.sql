-- NOT APPLIED by this repository change. Review and run only after the owner
-- approves Gate 2. Does not ALTER listings, escrows, tasks, or notes, and does
-- not change their grants. Those tables currently include broad privileges
-- such as TRUNCATE; leave that hardening for a separate review.
--
-- No owner UUID is inserted. SPCX is not seeded. No watchlist rows are seeded.
-- The publisher role is NOLOGIN until an operator sets a password out of band.

create extension if not exists pgcrypto;

-- Abort if a previous or conflicting object is already present. This file does
-- not drop or rewrite those objects.
do $$ begin
  if to_regclass('public.watchlist') is not null
     or to_regclass('public.research_findings') is not null
     or to_regclass('public.ingestion_runs') is not null
     or to_regnamespace('hq_private') is not null then
    raise exception 'preflight abort: research objects already exist';
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hq_publisher') then
    create role hq_publisher nologin noinherit;
  end if;
end $$;

create schema hq_private;

revoke all on schema hq_private from public, anon, authenticated;
grant usage on schema hq_private to hq_publisher;

create table hq_private.owner_config (
  singleton int primary key check (singleton = 1),
  owner_id uuid not null,
  project_ref text not null check (project_ref = 'zjsvrfudkigjvvhlehdh'),
  bound_at timestamptz not null default now()
);

create table hq_private.instrument_allowlist (
  symbol text primary key check (symbol ~ '^[A-Z][A-Z0-9.]{0,9}$'),
  asset_type text not null check (asset_type in ('equity', 'etf', 'fund', 'cash', 'other')),
  verification_state text not null check (verification_state in ('verified', 'unverified')),
  publishable boolean not null default false,
  issuer text,
  exchange text,
  note text,
  check (publishable = false or verification_state = 'verified')
);

create table hq_private.publish_attempts (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  run_id uuid,
  at timestamptz not null default now()
);

create table public.watchlist (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  bucket text not null check (bucket in ('holding', 'watch', 'candidate')),
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.]{0,9}$'),
  asset_type text,
  source_note text,
  as_of timestamptz,
  sort_order int not null default 0,
  updated_at timestamptz not null default now(),
  unique (owner_id, bucket, symbol)
);

create table public.ingestion_runs (
  run_id uuid primary key,
  owner_id uuid not null,
  schema_version int not null,
  researched_at timestamptz not null,
  received_at timestamptz not null default now(),
  outcome text not null check (outcome in ('publish', 'no_change', 'error')),
  payload_hash text not null,
  accepted_count int not null default 0,
  error_code text,
  unique (owner_id, run_id)
);

create table public.research_findings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  run_id uuid not null references public.ingestion_runs (run_id),
  finding_key text not null check (char_length(finding_key) between 1 and 80),
  category text not null check (category in ('company_news', 'global_markets', 'world_events', 'analysis')),
  horizon text not null check (horizon in ('short', 'long', 'trend')),
  symbol text,
  impacted text[] not null default '{}',
  title text not null,
  summary text not null,
  thesis text,
  contrary text,
  catalyst text,
  downside text,
  invalidation text,
  risk text not null check (risk in ('baseline', 'high')),
  source_published_at timestamptz not null,
  sources jsonb not null,
  researched_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  unique (owner_id, run_id, finding_key)
);

create index watchlist_owner_idx on public.watchlist (owner_id, bucket, sort_order);
create index findings_owner_run_idx on public.research_findings (owner_id, run_id);
create index runs_owner_time_idx on public.ingestion_runs (owner_id, researched_at desc);

alter table public.watchlist enable row level security;
alter table public.research_findings enable row level security;
alter table public.ingestion_runs enable row level security;
alter table public.watchlist force row level security;
alter table public.research_findings force row level security;
alter table public.ingestion_runs force row level security;

create or replace function hq_private.is_bound_owner()
returns boolean
language sql
stable
security definer
set search_path = hq_private, pg_temp
as $$
  select exists (
    select 1 from hq_private.owner_config c
    where c.singleton = 1 and c.owner_id = auth.uid()
  );
$$;

revoke all on function hq_private.is_bound_owner() from public, anon;
grant execute on function hq_private.is_bound_owner() to authenticated;

create policy owner_select on public.watchlist for select to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner());
create policy owner_select on public.research_findings for select to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner());
create policy owner_select on public.ingestion_runs for select to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner());

revoke all on table public.watchlist from public, anon, authenticated;
revoke all on table public.research_findings from public, anon, authenticated;
revoke all on table public.ingestion_runs from public, anon, authenticated;
grant select on table public.watchlist to authenticated;
grant select on table public.research_findings to authenticated;
grant select on table public.ingestion_runs to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on table public.watchlist from service_role';
    execute 'revoke all on table public.research_findings from service_role';
    execute 'revoke all on table public.ingestion_runs from service_role';
  end if;
end $$;

create or replace function hq_private.json_forbidden(p jsonb)
returns text
language plpgsql
immutable
as $fn$
declare
  k text;
  v jsonb;
  child text;
  forbidden text[] := array[
    'owner_id','destination','sql','query','credential','credentials','secret','secrets',
    'service_role','password','api_key','access_token','project_ref','project_id',
    'price','quote','last','bid','ask','balance','shares','quantity','pnl','market_value',
    'nav','close','open','high','low','volume'
  ];
begin
  if p is null then return null; end if;
  if jsonb_typeof(p) = 'object' then
    for k, v in select * from jsonb_each(p) loop
      if k = any (forbidden) then return k; end if;
      child := hq_private.json_forbidden(v);
      if child is not null then return child; end if;
    end loop;
  elsif jsonb_typeof(p) = 'array' then
    for v in select value from jsonb_array_elements(p) loop
      child := hq_private.json_forbidden(v);
      if child is not null then return child; end if;
    end loop;
  end if;
  return null;
end;
$fn$;

create or replace function hq_private.https_ok(raw text)
returns boolean
language plpgsql
immutable
as $fn$
declare
  host text;
begin
  if raw is null or raw !~ '^https://' then return false; end if;
  if position('@' in raw) > 0 then return false; end if;
  host := lower(substring(raw from '^https://([^/:]+)'));
  if host is null or host in ('localhost', '0.0.0.0') or host like '%.local' then return false; end if;
  if host ~ '^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' then return false; end if;
  if raw !~ '^https://[A-Za-z0-9.-]+(?::[0-9]{2,5})?(/[^[:space:]]*)?$' then return false; end if;
  return true;
end;
$fn$;

create or replace function hq_private.symbol_allowed(sym text)
returns boolean
language sql
stable
security definer
set search_path = hq_private, pg_temp
as $$
  select exists (
    select 1 from hq_private.instrument_allowlist a
    where a.symbol = sym and a.publishable and a.verification_state = 'verified'
  );
$$;

create or replace function hq_private.publish_stock_research(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  cfg hq_private.owner_config%rowtype;
  run uuid;
  researched timestamptz;
  outcome text;
  hash text;
  existing public.ingestion_runs%rowtype;
  last_at timestamptz;
  bad text;
  n int;
  inst jsonb;
  rec jsonb;
  src jsonb;
  sym text;
  impacted text[];
  keys text[] := '{}';
  k text;
  attempts int;
  accepted int := 0;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if octet_length(payload::text) > 262144 then
    return jsonb_build_object('ok', false, 'error_code', 'oversize');
  end if;

  select * into cfg from hq_private.owner_config where singleton = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'owner_not_configured');
  end if;
  perform pg_advisory_xact_lock(hashtext('hq_research_publish'));

  bad := hq_private.json_forbidden(payload);
  if bad is not null then
    return jsonb_build_object('ok', false, 'error_code', 'forbidden_field', 'field', bad);
  end if;

  begin
    if (payload->>'schema_version')::int <> 1 then
      return jsonb_build_object('ok', false, 'error_code', 'bad_version');
    end if;
    run := (payload->>'run_id')::uuid;
    researched := (payload->>'researched_at')::timestamptz;
    outcome := payload->>'outcome';
  exception when others then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end;

  if run is null or researched is null or outcome not in ('publish', 'no_change') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if payload ? 'instruments' and outcome = 'no_change' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if payload ? 'findings' and outcome = 'no_change' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;

  hash := md5(payload::text);
  select * into existing from public.ingestion_runs where run_id = run;
  if found then
    if existing.owner_id <> cfg.owner_id or existing.payload_hash <> hash then
      return jsonb_build_object('ok', false, 'error_code', 'replay_conflict', 'run_id', run);
    end if;
    return jsonb_build_object(
      'ok', existing.outcome <> 'error',
      'replay', true,
      'run_id', run,
      'outcome', existing.outcome,
      'error_code', existing.error_code,
      'accepted_count', existing.accepted_count,
      'researched_at', existing.researched_at
    );
  end if;

  select count(*) into attempts from hq_private.publish_attempts
    where owner_id = cfg.owner_id and at > now() - interval '1 hour';
  if attempts >= 10 then
    return jsonb_build_object('ok', false, 'error_code', 'rate_limited');
  end if;
  insert into hq_private.publish_attempts (owner_id, run_id) values (cfg.owner_id, run);

  if researched > now() + interval '2 minutes' then
    insert into public.ingestion_runs (run_id, owner_id, schema_version, researched_at, outcome, payload_hash, error_code)
    values (run, cfg.owner_id, 1, researched, 'error', hash, 'future_timestamp');
    return jsonb_build_object('ok', false, 'error_code', 'future_timestamp', 'run_id', run);
  end if;
  if researched < now() - interval '7 days' then
    insert into public.ingestion_runs (run_id, owner_id, schema_version, researched_at, outcome, payload_hash, error_code)
    values (run, cfg.owner_id, 1, researched, 'error', hash, 'too_old');
    return jsonb_build_object('ok', false, 'error_code', 'too_old', 'run_id', run);
  end if;

  select max(researched_at) into last_at from public.ingestion_runs r
    where r.owner_id = cfg.owner_id and r.outcome in ('publish', 'no_change');
  if last_at is not null and researched <= last_at then
    insert into public.ingestion_runs (run_id, owner_id, schema_version, researched_at, outcome, payload_hash, error_code)
    values (run, cfg.owner_id, 1, researched, 'error', hash, 'stale_run');
    return jsonb_build_object('ok', false, 'error_code', 'stale_run', 'run_id', run);
  end if;

  if outcome = 'publish' then
    if jsonb_typeof(payload->'findings') <> 'array' or jsonb_array_length(payload->'findings') < 1
       or jsonb_array_length(payload->'findings') > 50 then
      insert into public.ingestion_runs (run_id, owner_id, schema_version, researched_at, outcome, payload_hash, error_code)
      values (run, cfg.owner_id, 1, researched, 'error', hash, 'invalid_payload');
      return jsonb_build_object('ok', false, 'error_code', 'invalid_payload', 'run_id', run);
    end if;
    if payload ? 'instruments' then
      if jsonb_typeof(payload->'instruments') <> 'array' or jsonb_array_length(payload->'instruments') > 40 then
        insert into public.ingestion_runs (run_id, owner_id, schema_version, researched_at, outcome, payload_hash, error_code)
        values (run, cfg.owner_id, 1, researched, 'error', hash, 'invalid_payload');
        return jsonb_build_object('ok', false, 'error_code', 'invalid_payload', 'run_id', run);
      end if;
      for inst in select value from jsonb_array_elements(payload->'instruments') loop
        sym := inst->>'symbol';
        if inst->>'bucket' not in ('holding', 'watch', 'candidate') or not hq_private.symbol_allowed(sym) then
          insert into public.ingestion_runs (run_id, owner_id, schema_version, researched_at, outcome, payload_hash, error_code)
          values (run, cfg.owner_id, 1, researched, 'error', hash, 'unknown_symbol');
          return jsonb_build_object('ok', false, 'error_code', 'unknown_symbol', 'run_id', run);
        end if;
      end loop;
    end if;

    for rec in select value from jsonb_array_elements(payload->'findings') loop
      if rec->>'category' not in ('company_news', 'global_markets', 'world_events', 'analysis')
         or rec->>'horizon' not in ('short', 'long', 'trend')
         or rec->>'risk' not in ('baseline', 'high')
         or coalesce(rec->>'title', '') = '' or char_length(rec->>'title') > 180
         or coalesce(rec->>'summary', '') = '' or char_length(rec->>'summary') > 2000
         or char_length(coalesce(rec->>'thesis', '')) > 2000
         or char_length(coalesce(rec->>'contrary', '')) > 2000
         or rec->>'finding_key' !~ '^[A-Za-z0-9._:-]{1,80}$'
         or jsonb_typeof(rec->'sources') <> 'array'
         or jsonb_array_length(rec->'sources') < 1
         or jsonb_array_length(rec->'sources') > 5
         or rec->>'finding_key' = any (keys) then
        insert into public.ingestion_runs (run_id, owner_id, schema_version, researched_at, outcome, payload_hash, error_code)
        values (run, cfg.owner_id, 1, researched, 'error', hash, 'invalid_payload');
        return jsonb_build_object('ok', false, 'error_code', 'invalid_payload', 'run_id', run);
      end if;
      keys := keys || (rec->>'finding_key');
      if rec->>'category' = 'company_news' and not hq_private.symbol_allowed(rec->>'symbol') then
        insert into public.ingestion_runs (run_id, owner_id, schema_version, researched_at, outcome, payload_hash, error_code)
        values (run, cfg.owner_id, 1, researched, 'error', hash, 'unknown_symbol');
        return jsonb_build_object('ok', false, 'error_code', 'unknown_symbol', 'run_id', run);
      end if;
      if rec->>'category' = 'analysis' and (
        coalesce(rec->>'thesis', '') = '' or coalesce(rec->>'contrary', '') = ''
        or jsonb_typeof(rec->'impacted') <> 'array' or jsonb_array_length(rec->'impacted') < 1
      ) then
        insert into public.ingestion_runs (run_id, owner_id, schema_version, researched_at, outcome, payload_hash, error_code)
        values (run, cfg.owner_id, 1, researched, 'error', hash, 'invalid_payload');
        return jsonb_build_object('ok', false, 'error_code', 'invalid_payload', 'run_id', run);
      end if;
      if jsonb_typeof(rec->'impacted') = 'array' then
        for sym in select value from jsonb_array_elements_text(rec->'impacted') loop
          if not hq_private.symbol_allowed(sym) then
            insert into public.ingestion_runs (run_id, owner_id, schema_version, researched_at, outcome, payload_hash, error_code)
            values (run, cfg.owner_id, 1, researched, 'error', hash, 'unknown_symbol');
            return jsonb_build_object('ok', false, 'error_code', 'unknown_symbol', 'run_id', run);
          end if;
        end loop;
      end if;
      for src in select value from jsonb_array_elements(rec->'sources') loop
        if not hq_private.https_ok(src->>'url') or coalesce(src->>'published_at', '') = '' then
          insert into public.ingestion_runs (run_id, owner_id, schema_version, researched_at, outcome, payload_hash, error_code)
          values (run, cfg.owner_id, 1, researched, 'error', hash, 'bad_url');
          return jsonb_build_object('ok', false, 'error_code', 'bad_url', 'run_id', run);
        end if;
      end loop;
    end loop;
  end if;

  insert into public.ingestion_runs (run_id, owner_id, schema_version, researched_at, outcome, payload_hash, accepted_count)
  values (run, cfg.owner_id, 1, researched, outcome, hash, case when outcome = 'publish' then jsonb_array_length(payload->'findings') else 0 end);

  if outcome = 'no_change' then
    return jsonb_build_object('ok', true, 'replay', false, 'run_id', run, 'outcome', 'no_change', 'accepted_count', 0, 'researched_at', researched);
  end if;

  if payload ? 'instruments' then
    delete from public.watchlist where owner_id = cfg.owner_id;
    insert into public.watchlist (owner_id, bucket, symbol, asset_type, source_note, as_of, sort_order)
    select cfg.owner_id, item->>'bucket', item->>'symbol', item->>'asset_type',
           left(coalesce(item->>'source_note', 'Owner-supplied snapshot. Not a live brokerage position.'), 300),
           researched, coalesce((item->>'sort_order')::int, 0)
    from jsonb_array_elements(payload->'instruments') item;
  end if;

  insert into public.research_findings (
    owner_id, run_id, finding_key, category, horizon, symbol, impacted, title, summary,
    thesis, contrary, catalyst, downside, invalidation, risk, source_published_at, sources, researched_at
  )
  select cfg.owner_id, run, item->>'finding_key', item->>'category', item->>'horizon', nullif(item->>'symbol', ''),
         coalesce(array(select jsonb_array_elements_text(item->'impacted')), '{}'),
         item->>'title', item->>'summary', nullif(item->>'thesis', ''), nullif(item->>'contrary', ''),
         nullif(item->>'catalyst', ''), nullif(item->>'downside', ''), nullif(item->>'invalidation', ''),
         item->>'risk', (item->'sources'->0->>'published_at')::timestamptz, item->'sources', researched
  from jsonb_array_elements(payload->'findings') item;

  get diagnostics accepted = row_count;
  return jsonb_build_object('ok', true, 'replay', false, 'run_id', run, 'outcome', 'publish', 'accepted_count', accepted, 'researched_at', researched);
exception when others then
  raise;
end;
$fn$;

create or replace function hq_private.research_status(p_run_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  cfg hq_private.owner_config%rowtype;
  rec public.ingestion_runs%rowtype;
  last_at timestamptz;
begin
  select * into cfg from hq_private.owner_config where singleton = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'owner_not_configured');
  end if;
  if p_run_id is not null then
    select * into rec from public.ingestion_runs where run_id = p_run_id and owner_id = cfg.owner_id;
  else
    select * into rec from public.ingestion_runs where owner_id = cfg.owner_id order by received_at desc limit 1;
  end if;
  select max(researched_at) into last_at from public.ingestion_runs r
    where r.owner_id = cfg.owner_id and r.outcome = 'publish';
  return jsonb_build_object(
    'ok', true,
    'configured', true,
    'last_good_researched_at', last_at,
    'run', case when rec.run_id is null then null else jsonb_build_object(
      'run_id', rec.run_id, 'outcome', rec.outcome, 'error_code', rec.error_code,
      'accepted_count', rec.accepted_count, 'researched_at', rec.researched_at, 'received_at', rec.received_at
    ) end
  );
end;
$fn$;

revoke all on function hq_private.publish_stock_research(jsonb) from public, anon, authenticated;
revoke all on function hq_private.research_status(uuid) from public, anon, authenticated;
revoke all on function hq_private.json_forbidden(jsonb) from public, anon, authenticated;
revoke all on function hq_private.https_ok(text) from public, anon, authenticated;
revoke all on function hq_private.symbol_allowed(text) from public, anon, authenticated;
grant execute on function hq_private.publish_stock_research(jsonb) to hq_publisher;
grant execute on function hq_private.research_status(uuid) to hq_publisher;

comment on function hq_private.publish_stock_research(jsonb) is
  'Restricted writer. Owner and project come from hq_private.owner_config. Caller-supplied owner_id, destination, SQL, secrets, and quote fields are rejected. Not granted to anon, authenticated, or the browser.';
