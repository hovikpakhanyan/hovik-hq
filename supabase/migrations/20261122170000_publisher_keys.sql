-- NOT APPLIED by this repository change. Review and run only after the owner
-- approves it. Requires 20261107120000_research_publisher.sql,
-- 20261107143000_oauth_token_store.sql, and 20261107170000_oauth_guard.sql.
-- Independent of 20261111223000_deal_publisher.sql, which stays unapplied.
--
-- Long-lived publisher keys, one or more per named client. Only the SHA-256
-- hex of a key is stored; the plaintext is never written to the database.
-- Scopes are fixed per client by a table check, so no key can ever carry a
-- deal, listing, pipeline, or escrow scope. hq_publisher gets no table
-- privileges; it can only execute the security definer functions below.
-- Does not alter listings, escrows, tasks, notes, or the OAuth tables.

do $$ begin
  if to_regnamespace('hq_private') is null
     or to_regclass('hq_private.owner_config') is null
     or to_regclass('public.research_findings') is null then
    raise exception 'preflight abort: research publisher objects are missing';
  end if;
  if to_regclass('hq_private.oauth_throttle') is null then
    raise exception 'preflight abort: oauth guard migration is missing';
  end if;
  if to_regclass('hq_private.publisher_keys') is not null then
    raise exception 'preflight abort: publisher keys already exist';
  end if;
end $$;

create table hq_private.publisher_keys (
  id uuid primary key default gen_random_uuid(),
  client text not null check (client in ('grok-bot', 'claude', 'instinct')),
  label text not null default '' check (char_length(label) <= 80),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days',
  revoked_at timestamptz,
  last_used_at timestamptz,
  constraint publisher_keys_scopes_known check (
    cardinality(scopes) >= 1
    and scopes <@ array['research.publish', 'research.status.read', 'research.read']::text[]
  ),
  constraint publisher_keys_client_scopes check (
    (client = 'grok-bot' and scopes <@ array['research.publish', 'research.status.read']::text[])
    or (client in ('claude', 'instinct') and scopes <@ array['research.status.read', 'research.read']::text[])
  ),
  constraint publisher_keys_lifetime check (
    expires_at > created_at and expires_at <= created_at + interval '366 days'
  )
);

create index publisher_keys_client_idx on hq_private.publisher_keys (client, revoked_at, expires_at);

alter table hq_private.publisher_keys enable row level security;
alter table hq_private.publisher_keys force row level security;
revoke all on table hq_private.publisher_keys from public, anon, authenticated, hq_publisher;

-- Fixed default scopes per client. The issuer never takes scopes from the caller.
create or replace function hq_private.publisher_key_default_scopes(p_client text)
returns text[]
language sql
immutable
set search_path = hq_private, pg_temp
as $$
  select case p_client
    when 'grok-bot' then array['research.publish', 'research.status.read']::text[]
    when 'claude' then array['research.status.read', 'research.read']::text[]
    when 'instinct' then array['research.status.read', 'research.read']::text[]
    else null
  end;
$$;

-- Looks up one active key by hash and stamps last_used_at at most once a minute.
create or replace function hq_private.publisher_key_check(p_hash text)
returns table (key_hash text, client text, scopes text[])
language plpgsql
security definer
set search_path = hq_private, pg_temp
as $fn$
declare
  row hq_private.publisher_keys%rowtype;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  select * into row from hq_private.publisher_keys k
    where k.key_hash = p_hash and k.revoked_at is null and k.expires_at > now();
  if not found then
    return;
  end if;
  if row.last_used_at is null or row.last_used_at < now() - interval '1 minute' then
    update hq_private.publisher_keys set last_used_at = now() where id = row.id;
  end if;
  return query select row.key_hash, row.client, row.scopes;
end;
$fn$;

-- Inserts a key hash for one client with that client's fixed scopes and a
-- 90-day expiry. At most three active keys per client so rotation can overlap.
create or replace function hq_private.publisher_key_issue(p_hash text, p_client text, p_label text default '')
returns jsonb
language plpgsql
security definer
set search_path = hq_private, pg_temp
as $fn$
declare
  wanted text[] := hq_private.publisher_key_default_scopes(p_client);
  active int;
  created hq_private.publisher_keys%rowtype;
begin
  if wanted is null then
    return jsonb_build_object('ok', false, 'error_code', 'unknown_client');
  end if;
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error_code', 'bad_hash');
  end if;
  perform pg_advisory_xact_lock(hashtext('hq_publisher_key_issue:' || p_client));
  select count(*) into active from hq_private.publisher_keys
    where client = p_client and revoked_at is null and expires_at > now();
  if active >= 3 then
    return jsonb_build_object('ok', false, 'error_code', 'too_many_active_keys');
  end if;
  insert into hq_private.publisher_keys (client, label, key_hash, scopes)
  values (p_client, left(coalesce(p_label, ''), 80), p_hash, wanted)
  returning * into created;
  return jsonb_build_object(
    'ok', true, 'id', created.id, 'client', created.client,
    'scopes', to_jsonb(created.scopes), 'expires_at', created.expires_at
  );
end;
$fn$;

-- Lists keys without hashes or plaintext.
create or replace function hq_private.publisher_key_list()
returns jsonb
language sql
stable
security definer
set search_path = hq_private, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', k.id, 'client', k.client, 'label', k.label, 'scopes', to_jsonb(k.scopes),
    'created_at', k.created_at, 'expires_at', k.expires_at,
    'revoked_at', k.revoked_at, 'last_used_at', k.last_used_at
  ) order by k.created_at desc), '[]'::jsonb)
  from hq_private.publisher_keys k;
$$;

create or replace function hq_private.publisher_key_revoke(p_id uuid)
returns boolean
language sql
security definer
set search_path = hq_private, pg_temp
as $$
  with done as (
    update hq_private.publisher_keys set revoked_at = now()
    where id = p_id and revoked_at is null
    returning 1
  )
  select exists (select 1 from done);
$$;

-- Read-only view of the bound owner's own published research notes. No
-- watchlist, deal, listing, pipeline, or escrow data.
create or replace function hq_private.read_stock_research(
  p_limit int default 20, p_symbol text default null, p_run_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  cfg hq_private.owner_config%rowtype;
  cap int := least(greatest(coalesce(p_limit, 20), 1), 50);
  notes jsonb;
begin
  select * into cfg from hq_private.owner_config where singleton = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'owner_not_configured');
  end if;
  if p_symbol is not null and p_symbol !~ '^[A-Z][A-Z0-9.]{0,9}$' then
    return jsonb_build_object('ok', false, 'error_code', 'bad_symbol');
  end if;
  select coalesce(jsonb_agg(n order by n_at desc, n_key), '[]'::jsonb) into notes
  from (
    select f.researched_at as n_at, f.finding_key as n_key, jsonb_build_object(
      'run_id', f.run_id, 'finding_key', f.finding_key, 'category', f.category,
      'horizon', f.horizon, 'symbol', f.symbol, 'impacted', to_jsonb(f.impacted),
      'title', f.title, 'summary', f.summary, 'thesis', f.thesis, 'contrary', f.contrary,
      'catalyst', f.catalyst, 'downside', f.downside, 'invalidation', f.invalidation,
      'risk', f.risk, 'source_published_at', f.source_published_at, 'sources', f.sources,
      'researched_at', f.researched_at
    ) as n
    from public.research_findings f
    where f.owner_id = cfg.owner_id
      and (p_symbol is null or f.symbol = p_symbol)
      and (p_run_id is null or f.run_id = p_run_id)
    order by f.researched_at desc, f.finding_key
    limit cap
  ) rows;
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(notes), 'notes', notes);
end;
$fn$;

revoke all on function hq_private.publisher_key_default_scopes(text) from public, anon, authenticated;
revoke all on function hq_private.publisher_key_check(text) from public, anon, authenticated;
revoke all on function hq_private.publisher_key_issue(text, text, text) from public, anon, authenticated;
revoke all on function hq_private.publisher_key_list() from public, anon, authenticated;
revoke all on function hq_private.publisher_key_revoke(uuid) from public, anon, authenticated;
revoke all on function hq_private.read_stock_research(int, text, uuid) from public, anon, authenticated;
grant execute on function hq_private.publisher_key_check(text) to hq_publisher;
grant execute on function hq_private.publisher_key_issue(text, text, text) to hq_publisher;
grant execute on function hq_private.publisher_key_list() to hq_publisher;
grant execute on function hq_private.publisher_key_revoke(uuid) to hq_publisher;
grant execute on function hq_private.read_stock_research(int, text, uuid) to hq_publisher;

comment on table hq_private.publisher_keys is
  'Long-lived publisher keys. Stores only sha256 hex of the key. Scopes are fixed per client and can never include deal, listing, pipeline, or escrow access.';
comment on function hq_private.publisher_key_issue(text, text, text) is
  'Called by the owner-gated /publisher/keys page. Scopes and the 90-day expiry come from the database, not the caller.';
