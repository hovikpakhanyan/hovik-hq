-- NOT APPLIED by this repository change. Do not run it until the owner approves.
-- Apply only after, in order:
--   20261107120000_research_publisher.sql
--   20261107143000_oauth_token_store.sql
--   20261107170000_oauth_guard.sql
--   20261111223000_deal_publisher.sql
--   20261122170000_publisher_keys.sql
--   20261123053000_claude_publish_scope.sql
--
-- Widens publisher-key scopes so a NEW grok-bot or claude key can read and
-- write listings, pipeline, escrow, tasks, notes, the watchlist, and the
-- investment plan, plus the research scopes it already has. instinct stays
-- research.status.read and research.read. Existing publisher_keys rows are
-- not updated. No seed rows are inserted. No service-role key is created.
-- hq_publisher receives no table privileges, only security-definer functions.
-- Does not ALTER public.listings, public.escrows, public.tasks, or public.notes.

do $$ begin
  if to_regclass('public.deal_records') is null
     or to_regprocedure('hq_private.publish_deal(jsonb)') is null
     or to_regprocedure('hq_private.deal_status(text)') is null then
    raise exception 'preflight abort: deal publisher migration is missing';
  end if;
  if to_regclass('hq_private.publisher_keys') is null
     or to_regprocedure('hq_private.publisher_key_default_scopes(text)') is null
     or to_regprocedure('hq_private.publisher_key_check(text)') is null
     or to_regprocedure('hq_private.publisher_key_issue(text, text, text)') is null
     or to_regprocedure('hq_private.json_forbidden(jsonb)') is null
     or to_regprocedure('hq_private.is_bound_owner()') is null then
    raise exception 'preflight abort: publisher key or research migration is missing';
  end if;
  if to_regclass('public.hq_tasks') is not null
     or to_regclass('public.hq_notes') is not null
     or to_regclass('public.hq_plan') is not null
     or to_regclass('hq_private.mcp_audit') is not null then
    raise exception 'preflight abort: hq domain objects already exist';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'deal_records' and column_name = 'archived_at'
  ) then
    raise exception 'preflight abort: deal_records.archived_at already exists';
  end if;
end $$;

lock table hq_private.publisher_keys in access exclusive mode;

create temporary table publisher_keys_snapshot as
  select id, client, label, key_hash, scopes, created_at, expires_at, revoked_at, last_used_at
  from hq_private.publisher_keys;

create temporary table publisher_fn_owners as
  select p.proname, r.rolname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'hq_private'
    and (
      (p.proname = 'publisher_key_default_scopes' and pg_get_function_identity_arguments(p.oid) = 'p_client text')
      or (p.proname = 'publisher_key_check' and pg_get_function_identity_arguments(p.oid) = 'p_hash text')
    );

alter table hq_private.publisher_keys drop constraint publisher_keys_scopes_known;
alter table hq_private.publisher_keys add constraint publisher_keys_scopes_known check (
  cardinality(scopes) >= 1
  and scopes <@ array[
    'research.publish', 'research.status.read', 'research.read',
    'listings.read', 'listings.write',
    'pipeline.read', 'pipeline.write',
    'escrow.read', 'escrow.write',
    'tasks.read', 'tasks.write',
    'notes.read', 'notes.write',
    'watchlist.read', 'watchlist.write',
    'plan.read', 'plan.write'
  ]::text[]
);

alter table hq_private.publisher_keys drop constraint publisher_keys_client_scopes;
alter table hq_private.publisher_keys add constraint publisher_keys_client_scopes check (
  (client in ('grok-bot', 'claude') and scopes <@ array[
    'research.publish', 'research.status.read', 'research.read',
    'listings.read', 'listings.write',
    'pipeline.read', 'pipeline.write',
    'escrow.read', 'escrow.write',
    'tasks.read', 'tasks.write',
    'notes.read', 'notes.write',
    'watchlist.read', 'watchlist.write',
    'plan.read', 'plan.write'
  ]::text[])
  or (client = 'instinct' and scopes <@ array['research.status.read', 'research.read']::text[])
);

create or replace function hq_private.publisher_key_default_scopes(p_client text)
returns text[]
language sql
immutable
set search_path = hq_private, pg_temp
as $$
  select case p_client
    when 'grok-bot' then array[
      'research.publish', 'research.status.read', 'research.read',
      'listings.read', 'listings.write',
      'pipeline.read', 'pipeline.write',
      'escrow.read', 'escrow.write',
      'tasks.read', 'tasks.write',
      'notes.read', 'notes.write',
      'watchlist.read', 'watchlist.write',
      'plan.read', 'plan.write'
    ]::text[]
    when 'claude' then array[
      'research.publish', 'research.status.read', 'research.read',
      'listings.read', 'listings.write',
      'pipeline.read', 'pipeline.write',
      'escrow.read', 'escrow.write',
      'tasks.read', 'tasks.write',
      'notes.read', 'notes.write',
      'watchlist.read', 'watchlist.write',
      'plan.read', 'plan.write'
    ]::text[]
    when 'instinct' then array['research.status.read', 'research.read']::text[]
    else null
  end;
$$;

drop function hq_private.publisher_key_check(text);

create function hq_private.publisher_key_check(p_hash text)
returns table (key_hash text, client text, scopes text[], key_id uuid)
language plpgsql
security definer
set search_path = hq_private, pg_temp
as $fn$
declare
  found_key hq_private.publisher_keys%rowtype;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  select * into found_key from hq_private.publisher_keys k
    where k.key_hash = p_hash and k.revoked_at is null and k.expires_at > now();
  if not found then
    return;
  end if;
  if found_key.last_used_at is null or found_key.last_used_at < now() - interval '1 minute' then
    update hq_private.publisher_keys set last_used_at = now() where id = found_key.id;
  end if;
  return query select found_key.key_hash, found_key.client, found_key.scopes, found_key.id;
end;
$fn$;

do $$
declare
  rec record;
begin
  for rec in select proname, rolname from publisher_fn_owners loop
    if rec.proname = 'publisher_key_default_scopes' then
      execute format('alter function hq_private.publisher_key_default_scopes(text) owner to %I', rec.rolname);
    elsif rec.proname = 'publisher_key_check' then
      execute format('alter function hq_private.publisher_key_check(text) owner to %I', rec.rolname);
    end if;
  end loop;
end $$;

revoke all on function hq_private.publisher_key_default_scopes(text) from public, anon, authenticated;
revoke all on function hq_private.publisher_key_check(text) from public, anon, authenticated;
grant execute on function hq_private.publisher_key_check(text) to hq_publisher;

comment on table hq_private.publisher_keys is
  'Long-lived publisher keys. Stores only sha256 hex of the key. grok-bot and claude may hold HQ read/write scopes. instinct may hold only research.status.read and research.read. No service-role, SQL, or trade scope exists.';

alter table public.deal_records add column archived_at timestamptz;
create index deal_records_active_idx on public.deal_records (owner_id, kind) where archived_at is null;

create or replace function hq_private.deal_status(p_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  cfg hq_private.owner_config%rowtype;
  rec public.deal_records%rowtype;
begin
  select * into cfg from hq_private.owner_config where singleton = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'owner_not_configured');
  end if;
  if p_key is not null and btrim(p_key) <> '' then
    select * into rec from public.deal_records
      where owner_id = cfg.owner_id and external_key = btrim(p_key);
    if not found then
      return jsonb_build_object('ok', true, 'configured', true, 'found', false);
    end if;
    return jsonb_build_object(
      'ok', true,
      'configured', true,
      'found', true,
      'record', jsonb_build_object(
        'external_key', rec.external_key,
        'kind', rec.kind,
        'lane', rec.lane,
        'title', rec.title,
        'status_label', rec.status_label,
        'price_cents', rec.price_cents,
        'net_est_cents', rec.net_est_cents,
        'closed_on', rec.closed_on,
        'source_updated_at', rec.source_updated_at,
        'archived', rec.archived_at is not null
      )
    );
  end if;
  return jsonb_build_object(
    'ok', true,
    'configured', true,
    'counts', jsonb_build_object(
      'listing', (select count(*) from public.deal_records where owner_id = cfg.owner_id and kind = 'listing' and archived_at is null),
      'pipeline', (select count(*) from public.deal_records where owner_id = cfg.owner_id and kind = 'pipeline' and archived_at is null),
      'escrow', (select count(*) from public.deal_records where owner_id = cfg.owner_id and kind = 'escrow' and archived_at is null)
    )
  );
end;
$fn$;

create table hq_private.mcp_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  client text not null check (client in ('oauth', 'grok-bot', 'claude', 'instinct')),
  key_id uuid,
  tool text not null check (char_length(tool) between 1 and 80),
  row_id text not null check (char_length(row_id) between 1 and 80)
);

create table hq_private.mcp_write_attempts (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  tool text not null,
  at timestamptz not null default now()
);

create index mcp_audit_at_idx on hq_private.mcp_audit (at desc);
create index mcp_write_attempts_idx on hq_private.mcp_write_attempts (owner_id, tool, at desc);

alter table hq_private.mcp_audit enable row level security;
alter table hq_private.mcp_write_attempts enable row level security;
alter table hq_private.mcp_audit force row level security;
alter table hq_private.mcp_write_attempts force row level security;
revoke all on table hq_private.mcp_audit from public, anon, authenticated, hq_publisher;
revoke all on table hq_private.mcp_write_attempts from public, anon, authenticated, hq_publisher;

create table public.hq_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  external_key text check (external_key is null or external_key ~ '^[A-Za-z0-9._:-]{1,80}$'),
  subject text not null check (char_length(subject) between 1 and 180),
  note text not null default '' check (char_length(note) <= 4000),
  priority text not null default '' check (char_length(priority) <= 40),
  completed boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, external_key),
  check (completed = (completed_at is not null))
);

create table public.hq_notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  external_key text check (external_key is null or external_key ~ '^[A-Za-z0-9._:-]{1,80}$'),
  body text not null check (char_length(body) between 1 and 4000),
  source text not null default 'hq' check (source in ('hq', 'conductor', 'export', 'owner')),
  status text not null default 'open' check (status in ('open', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, external_key)
);

create table public.hq_plan (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique,
  title text not null check (char_length(title) between 1 and 180),
  body text not null check (char_length(body) between 1 and 65536),
  source text not null check (source in ('investment-plan.md', 'owner')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index hq_tasks_owner_idx on public.hq_tasks (owner_id, updated_at desc);
create index hq_notes_owner_idx on public.hq_notes (owner_id, updated_at desc);

alter table public.hq_tasks enable row level security;
alter table public.hq_notes enable row level security;
alter table public.hq_plan enable row level security;
alter table public.hq_tasks force row level security;
alter table public.hq_notes force row level security;
alter table public.hq_plan force row level security;

create policy owner_select on public.hq_tasks for select to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner());
create policy owner_insert on public.hq_tasks for insert to authenticated
  with check (owner_id = auth.uid() and hq_private.is_bound_owner());
create policy owner_update on public.hq_tasks for update to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner())
  with check (owner_id = auth.uid() and hq_private.is_bound_owner());
create policy owner_delete on public.hq_tasks for delete to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner());

create policy owner_select on public.hq_notes for select to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner());
create policy owner_insert on public.hq_notes for insert to authenticated
  with check (owner_id = auth.uid() and hq_private.is_bound_owner());
create policy owner_update on public.hq_notes for update to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner())
  with check (owner_id = auth.uid() and hq_private.is_bound_owner());
create policy owner_delete on public.hq_notes for delete to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner());

create policy owner_select on public.hq_plan for select to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner());
create policy owner_insert on public.hq_plan for insert to authenticated
  with check (owner_id = auth.uid() and hq_private.is_bound_owner());
create policy owner_update on public.hq_plan for update to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner())
  with check (owner_id = auth.uid() and hq_private.is_bound_owner());

create policy owner_insert on public.watchlist for insert to authenticated
  with check (owner_id = auth.uid() and hq_private.is_bound_owner());
create policy owner_update on public.watchlist for update to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner())
  with check (owner_id = auth.uid() and hq_private.is_bound_owner());
create policy owner_delete on public.watchlist for delete to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner());

revoke all on table public.hq_tasks from public, anon, authenticated, hq_publisher;
revoke all on table public.hq_notes from public, anon, authenticated, hq_publisher;
revoke all on table public.hq_plan from public, anon, authenticated, hq_publisher;
grant select, insert, update, delete on table public.hq_tasks to authenticated;
grant select, insert, update, delete on table public.hq_notes to authenticated;
grant select, insert, update on table public.hq_plan to authenticated;
grant insert, update, delete on table public.watchlist to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on table public.hq_tasks from service_role';
    execute 'revoke all on table public.hq_notes from service_role';
    execute 'revoke all on table public.hq_plan from service_role';
    execute 'revoke all on table hq_private.mcp_audit from service_role';
    execute 'revoke all on table hq_private.mcp_write_attempts from service_role';
  end if;
end $$;

create or replace function hq_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger hq_tasks_touch before update on public.hq_tasks
  for each row execute function hq_private.touch_updated_at();
create trigger hq_notes_touch before update on public.hq_notes
  for each row execute function hq_private.touch_updated_at();
create trigger hq_plan_touch before update on public.hq_plan
  for each row execute function hq_private.touch_updated_at();

create or replace function hq_private.payload_gate(p jsonb, allowed text[], p_cap int)
returns text
language plpgsql
immutable
set search_path = hq_private, pg_temp
as $fn$
declare
  k text;
  bad text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return 'invalid_payload';
  end if;
  if octet_length(p::text) > p_cap then
    return 'oversize';
  end if;
  bad := hq_private.json_forbidden(p);
  if bad is not null then
    return 'forbidden_field';
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any (allowed)) then
      return 'invalid_payload';
    end if;
  end loop;
  return null;
end;
$fn$;

create or replace function hq_private.mcp_gate(p_client text, p_key_id uuid, p_scope text, p_tool text)
returns jsonb
language plpgsql
security definer
set search_path = hq_private, pg_temp
as $fn$
declare
  cfg hq_private.owner_config%rowtype;
  scopes text[];
  n int;
begin
  if p_client is null or p_client not in ('grok-bot', 'claude') or p_key_id is null then
    return jsonb_build_object('ok', false, 'error_code', 'bad_actor');
  end if;
  if p_scope is null or p_tool is null then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  select k.scopes into scopes from hq_private.publisher_keys k
    where k.id = p_key_id and k.client = p_client and k.revoked_at is null and k.expires_at > now();
  if not found or not (p_scope = any (scopes)) then
    return jsonb_build_object('ok', false, 'error_code', 'insufficient_scope');
  end if;
  select * into cfg from hq_private.owner_config where singleton = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'owner_not_configured');
  end if;
  select count(*) into n from hq_private.mcp_write_attempts
    where owner_id = cfg.owner_id and tool = p_tool and at > now() - interval '1 hour';
  if n >= 60 then
    return jsonb_build_object('ok', false, 'error_code', 'rate_limited');
  end if;
  insert into hq_private.mcp_write_attempts (owner_id, tool) values (cfg.owner_id, p_tool);
  return jsonb_build_object('ok', true, 'owner_id', cfg.owner_id);
end;
$fn$;

create or replace function hq_private.audit_write(p_client text, p_key_id uuid, p_tool text, p_row_id text)
returns void
language sql
security definer
set search_path = hq_private, pg_temp
as $$
  insert into hq_private.mcp_audit (client, key_id, tool, row_id)
  values (p_client, p_key_id, left(p_tool, 80), left(p_row_id, 80));
$$;

create or replace function hq_private.deal_write_scope(p_kind text)
returns text
language sql
immutable
as $$
  select case p_kind
    when 'listing' then 'listings.write'
    when 'pipeline' then 'pipeline.write'
    when 'escrow' then 'escrow.write'
    else null
  end;
$$;

create or replace function hq_private.deal_rows(
  p_kind text, p_key text, p_limit int default 20, p_include_archived boolean default false
) returns jsonb
language plpgsql
stable
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  cfg hq_private.owner_config%rowtype;
  cap int := least(greatest(coalesce(p_limit, 20), 1), 50);
  rec public.deal_records%rowtype;
  rows jsonb;
begin
  if p_kind not in ('listing', 'pipeline', 'escrow') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_key is not null and btrim(p_key) !~ '^[A-Za-z0-9._:-]{1,80}$' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  select * into cfg from hq_private.owner_config where singleton = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'owner_not_configured');
  end if;
  if p_key is not null and btrim(p_key) <> '' then
    select * into rec from public.deal_records
      where owner_id = cfg.owner_id and kind = p_kind and external_key = btrim(p_key);
    if not found then
      return jsonb_build_object('ok', true, 'found', false);
    end if;
    return jsonb_build_object('ok', true, 'found', true, 'record', jsonb_build_object(
      'id', rec.id, 'external_key', rec.external_key, 'kind', rec.kind, 'lane', rec.lane,
      'title', rec.title, 'status_label', rec.status_label, 'price_cents', rec.price_cents,
      'net_est_cents', rec.net_est_cents, 'closed_on', rec.closed_on, 'note', rec.note,
      'source_updated_at', rec.source_updated_at, 'updated_at', rec.updated_at,
      'archived', rec.archived_at is not null
    ));
  end if;
  select coalesce(jsonb_agg(item order by sort_at desc), '[]'::jsonb) into rows
  from (
    select r.updated_at as sort_at, jsonb_build_object(
      'id', r.id, 'external_key', r.external_key, 'kind', r.kind, 'lane', r.lane,
      'title', r.title, 'status_label', r.status_label, 'price_cents', r.price_cents,
      'net_est_cents', r.net_est_cents, 'closed_on', r.closed_on, 'note', r.note,
      'source_updated_at', r.source_updated_at, 'updated_at', r.updated_at,
      'archived', r.archived_at is not null
    ) as item
    from public.deal_records r
    where r.owner_id = cfg.owner_id and r.kind = p_kind
      and (coalesce(p_include_archived, false) or r.archived_at is null)
    order by r.updated_at desc
    limit cap
  ) listed;
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(rows), 'records', rows);
end;
$fn$;

create or replace function hq_private.deal_counts(p_kinds text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  cfg hq_private.owner_config%rowtype;
  counts jsonb := '{}'::jsonb;
  kind text;
begin
  select * into cfg from hq_private.owner_config where singleton = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'owner_not_configured');
  end if;
  if p_kinds is null or cardinality(p_kinds) < 1 then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  foreach kind in array p_kinds loop
    if kind not in ('listing', 'pipeline', 'escrow') then
      return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
    end if;
    counts := counts || jsonb_build_object(kind, (
      select count(*) from public.deal_records
      where owner_id = cfg.owner_id and deal_records.kind = kind and archived_at is null
    ));
  end loop;
  return jsonb_build_object('ok', true, 'configured', true, 'counts', counts);
end;
$fn$;

create or replace function hq_private.deal_mutate(
  p_kind text, p_action text, p_body jsonb, p_client text, p_key_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  err text;
  gate jsonb;
  owner uuid;
  tool text;
  scope text;
  rec public.deal_records%rowtype;
  key text;
  lane text;
  title text;
  status_label text;
  note text;
  price bigint;
  net bigint;
  closed date;
  source_at timestamptz;
  archived timestamptz;
  rid uuid;
begin
  if p_action not in ('create', 'update') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  scope := hq_private.deal_write_scope(p_kind);
  tool := p_action || '_' || case p_kind when 'listing' then 'listing' when 'pipeline' then 'pipeline' when 'escrow' then 'escrow' else '' end;
  if scope is null or tool = p_action || '_' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  err := hq_private.payload_gate(p_body, array[
    'external_key', 'title', 'status_label', 'lane', 'note',
    'price_cents', 'net_est_cents', 'closed_on', 'updated_at', 'archive'
  ], 8192);
  if err is not null then
    return jsonb_build_object('ok', false, 'error_code', err);
  end if;
  key := btrim(p_body->>'external_key');
  if key is null or key !~ '^[A-Za-z0-9._:-]{1,80}$' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'title' and (jsonb_typeof(p_body->'title') <> 'string' or char_length(btrim(p_body->>'title')) < 1 or char_length(btrim(p_body->>'title')) > 180) then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'status_label' and (jsonb_typeof(p_body->'status_label') <> 'string' or char_length(btrim(p_body->>'status_label')) < 1 or char_length(btrim(p_body->>'status_label')) > 80) then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'lane' and jsonb_typeof(p_body->'lane') <> 'string' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'note' and jsonb_typeof(p_body->'note') not in ('string', 'null') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'note' and jsonb_typeof(p_body->'note') = 'string' and char_length(p_body->>'note') > 2000 then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'archive' and jsonb_typeof(p_body->'archive') <> 'boolean' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action = 'create' and coalesce(p_body->>'archive', 'false') = 'true' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'price_cents' and jsonb_typeof(p_body->'price_cents') not in ('number', 'null') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'net_est_cents' and jsonb_typeof(p_body->'net_est_cents') not in ('number', 'null') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'price_cents' and jsonb_typeof(p_body->'price_cents') = 'number' and (p_body->>'price_cents') !~ '^[0-9]{1,15}$' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'net_est_cents' and jsonb_typeof(p_body->'net_est_cents') = 'number' and (p_body->>'net_est_cents') !~ '^[0-9]{1,15}$' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action = 'create' and (
    not (p_body ? 'title') or not (p_body ? 'status_label') or not (p_body ? 'lane') or not (p_body ? 'updated_at')
  ) then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action = 'update' and not (
    p_body ? 'title' or p_body ? 'status_label' or p_body ? 'lane' or p_body ? 'note'
    or p_body ? 'price_cents' or p_body ? 'net_est_cents' or p_body ? 'closed_on'
    or p_body ? 'updated_at' or p_body ? 'archive'
  ) then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;

  gate := hq_private.mcp_gate(p_client, p_key_id, scope, tool);
  if coalesce(gate->>'ok', '') <> 'true' then
    return gate;
  end if;
  owner := (gate->>'owner_id')::uuid;

  if p_action = 'update' then
    select * into rec from public.deal_records
      where owner_id = owner and kind = p_kind and external_key = key
      for update;
    if not found then
      return jsonb_build_object('ok', false, 'error_code', 'not_found');
    end if;
    lane := coalesce(p_body->>'lane', rec.lane);
    title := coalesce(btrim(p_body->>'title'), rec.title);
    status_label := coalesce(btrim(p_body->>'status_label'), rec.status_label);
    if p_body ? 'note' then note := nullif(p_body->>'note', ''); else note := rec.note; end if;
    if p_body ? 'price_cents' then
      price := case when jsonb_typeof(p_body->'price_cents') = 'null' then null else (p_body->>'price_cents')::bigint end;
    else price := rec.price_cents; end if;
    if p_body ? 'net_est_cents' then
      net := case when jsonb_typeof(p_body->'net_est_cents') = 'null' then null else (p_body->>'net_est_cents')::bigint end;
    else net := rec.net_est_cents; end if;
    if p_body ? 'closed_on' then
      if coalesce(p_body->>'closed_on', '') = '' or jsonb_typeof(p_body->'closed_on') = 'null' then
        closed := null;
      else
        begin
          closed := (p_body->>'closed_on')::date;
        exception when others then
          return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
        end;
        if to_char(closed, 'YYYY-MM-DD') <> p_body->>'closed_on' then
          return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
        end if;
      end if;
    else
      closed := rec.closed_on;
    end if;
    if p_body ? 'updated_at' then
      begin
        source_at := (p_body->>'updated_at')::timestamptz;
      exception when others then
        return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
      end;
    else
      source_at := rec.source_updated_at;
    end if;
    if p_body ? 'archive' then
      archived := case when (p_body->>'archive')::boolean then coalesce(rec.archived_at, now()) else null end;
    else
      archived := rec.archived_at;
    end if;
  else
    lane := p_body->>'lane';
    title := btrim(p_body->>'title');
    status_label := btrim(p_body->>'status_label');
    note := nullif(p_body->>'note', '');
    price := case when p_body ? 'price_cents' and jsonb_typeof(p_body->'price_cents') = 'number' then (p_body->>'price_cents')::bigint else null end;
    net := case when p_body ? 'net_est_cents' and jsonb_typeof(p_body->'net_est_cents') = 'number' then (p_body->>'net_est_cents')::bigint else null end;
    closed := null;
    if p_body ? 'closed_on' and coalesce(p_body->>'closed_on', '') <> '' and jsonb_typeof(p_body->'closed_on') <> 'null' then
      begin
        closed := (p_body->>'closed_on')::date;
      exception when others then
        return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
      end;
      if to_char(closed, 'YYYY-MM-DD') <> p_body->>'closed_on' then
        return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
      end if;
    end if;
    begin
      source_at := (p_body->>'updated_at')::timestamptz;
    exception when others then
      return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
    end;
    archived := null;
  end if;

  if p_kind = 'listing' and lane not in ('current', 'upcoming', 'sold') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_kind = 'pipeline' and lane <> 'pipeline' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_kind = 'escrow' and lane <> 'escrow' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if closed is not null and lane <> 'sold' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if price is not null and price > 900000000000000 then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if net is not null and net > 900000000000000 then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if source_at is null then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if source_at > now() + interval '2 minutes' then
    return jsonb_build_object('ok', false, 'error_code', 'future_timestamp');
  end if;
  if source_at < now() - interval '10 years' then
    return jsonb_build_object('ok', false, 'error_code', 'too_old');
  end if;
  if title is null or char_length(title) < 1 or char_length(title) > 180
     or status_label is null or char_length(status_label) < 1 or char_length(status_label) > 80 then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;

  if p_action = 'create' then
    insert into public.deal_records (
      owner_id, external_key, kind, lane, title, status_label,
      price_cents, net_est_cents, closed_on, note, source_updated_at, archived_at
    ) values (
      owner, key, p_kind, lane, title, status_label, price, net, closed, note, source_at, null
    ) returning id into rid;
  else
    update public.deal_records as d set
      lane = v.lane,
      title = v.title,
      status_label = v.status_label,
      price_cents = v.price,
      net_est_cents = v.net,
      closed_on = v.closed,
      note = v.note,
      source_updated_at = v.source_at,
      archived_at = v.archived,
      updated_at = now()
    from (select lane, title, status_label, price, net, closed, note, source_at, archived) as v
    where d.id = rec.id
    returning d.id into rid;
  end if;

  perform hq_private.audit_write(p_client, p_key_id, tool, key);
  return jsonb_build_object(
    'ok', true, 'id', rid, 'external_key', key, 'kind', p_kind, 'lane', lane,
    'archived', archived is not null
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error_code', 'conflict');
end;
$fn$;

create or replace function hq_private.task_rows(p_id uuid, p_limit int default 20, p_completed boolean default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  cfg hq_private.owner_config%rowtype;
  cap int := least(greatest(coalesce(p_limit, 20), 1), 50);
  rec public.hq_tasks%rowtype;
  rows jsonb;
begin
  select * into cfg from hq_private.owner_config where singleton = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'owner_not_configured');
  end if;
  if p_id is not null then
    select * into rec from public.hq_tasks where id = p_id and owner_id = cfg.owner_id;
    if not found then
      return jsonb_build_object('ok', true, 'found', false);
    end if;
    return jsonb_build_object('ok', true, 'found', true, 'task', jsonb_build_object(
      'id', rec.id, 'external_key', rec.external_key, 'subject', rec.subject, 'note', rec.note,
      'priority', rec.priority, 'completed', rec.completed, 'completed_at', rec.completed_at,
      'created_at', rec.created_at, 'updated_at', rec.updated_at
    ));
  end if;
  select coalesce(jsonb_agg(item order by sort_at desc), '[]'::jsonb) into rows
  from (
    select t.updated_at as sort_at, jsonb_build_object(
      'id', t.id, 'external_key', t.external_key, 'subject', t.subject, 'note', t.note,
      'priority', t.priority, 'completed', t.completed, 'completed_at', t.completed_at,
      'created_at', t.created_at, 'updated_at', t.updated_at
    ) as item
    from public.hq_tasks t
    where t.owner_id = cfg.owner_id and (p_completed is null or t.completed = p_completed)
    order by t.updated_at desc
    limit cap
  ) listed;
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(rows), 'tasks', rows);
end;
$fn$;

create or replace function hq_private.task_mutate(p_action text, p_body jsonb, p_client text, p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  err text;
  gate jsonb;
  owner uuid;
  rec public.hq_tasks%rowtype;
  rid uuid;
  subject text;
  note text;
  priority text;
  completed boolean;
  completed_at timestamptz;
  external_key text;
begin
  if p_action not in ('create', 'update', 'delete') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  err := hq_private.payload_gate(p_body, case when p_action = 'delete' then array['id'] else array['id', 'external_key', 'subject', 'note', 'priority', 'completed', 'completed_at'] end, 20000);
  if err is not null then
    return jsonb_build_object('ok', false, 'error_code', err);
  end if;
  if p_action = 'create' and p_body ? 'id' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action in ('update', 'delete') and (not (p_body ? 'id') or (p_body->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'external_key' and jsonb_typeof(p_body->'external_key') not in ('string', 'null') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'external_key' and jsonb_typeof(p_body->'external_key') = 'string' and (p_body->>'external_key') !~ '^[A-Za-z0-9._:-]{1,80}$' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'subject' and (jsonb_typeof(p_body->'subject') <> 'string' or char_length(btrim(p_body->>'subject')) < 1 or char_length(btrim(p_body->>'subject')) > 180) then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'note' and (jsonb_typeof(p_body->'note') <> 'string' or char_length(p_body->>'note') > 4000) then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'priority' and (jsonb_typeof(p_body->'priority') <> 'string' or char_length(p_body->>'priority') > 40) then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'completed' and jsonb_typeof(p_body->'completed') <> 'boolean' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action = 'create' and not (p_body ? 'subject') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action = 'update' and not (p_body ? 'external_key' or p_body ? 'subject' or p_body ? 'note' or p_body ? 'priority' or p_body ? 'completed' or p_body ? 'completed_at') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;

  gate := hq_private.mcp_gate(p_client, p_key_id, 'tasks.write', p_action || '_task');
  if coalesce(gate->>'ok', '') <> 'true' then
    return gate;
  end if;
  owner := (gate->>'owner_id')::uuid;

  if p_action = 'delete' then
    delete from public.hq_tasks where id = (p_body->>'id')::uuid and owner_id = owner returning id into rid;
    if rid is null then
      return jsonb_build_object('ok', false, 'error_code', 'not_found');
    end if;
    perform hq_private.audit_write(p_client, p_key_id, 'delete_task', rid::text);
    return jsonb_build_object('ok', true, 'id', rid, 'deleted', true);
  end if;

  if p_action = 'update' then
    select * into rec from public.hq_tasks where id = (p_body->>'id')::uuid and owner_id = owner for update;
    if not found then
      return jsonb_build_object('ok', false, 'error_code', 'not_found');
    end if;
    subject := coalesce(btrim(p_body->>'subject'), rec.subject);
    note := case when p_body ? 'note' then p_body->>'note' else rec.note end;
    priority := case when p_body ? 'priority' then p_body->>'priority' else rec.priority end;
    external_key := case
      when p_body ? 'external_key' and jsonb_typeof(p_body->'external_key') = 'null' then null
      when p_body ? 'external_key' then p_body->>'external_key'
      else rec.external_key
    end;
    completed := case when p_body ? 'completed' then (p_body->>'completed')::boolean else rec.completed end;
  else
    subject := btrim(p_body->>'subject');
    note := coalesce(p_body->>'note', '');
    priority := coalesce(p_body->>'priority', '');
    external_key := case when p_body ? 'external_key' and jsonb_typeof(p_body->'external_key') = 'string' then p_body->>'external_key' else null end;
    completed := case when p_body ? 'completed' then (p_body->>'completed')::boolean else false end;
  end if;

  if completed then
    if p_body ? 'completed_at' and jsonb_typeof(p_body->'completed_at') not in ('string', 'null') then
      return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
    end if;
    if p_body ? 'completed_at' and jsonb_typeof(p_body->'completed_at') = 'string' then
      begin
        completed_at := (p_body->>'completed_at')::timestamptz;
      exception when others then
        return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
      end;
    elsif p_action = 'update' and rec.completed_at is not null and not (p_body ? 'completed') then
      completed_at := rec.completed_at;
    else
      completed_at := coalesce(case when p_action = 'update' then rec.completed_at else null end, now());
    end if;
    if completed_at is null or completed_at > now() + interval '2 minutes' or completed_at < now() - interval '10 years' then
      return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
    end if;
  else
    completed_at := null;
  end if;

  if p_action = 'create' then
    insert into public.hq_tasks (owner_id, external_key, subject, note, priority, completed, completed_at)
    values (owner, external_key, subject, note, priority, completed, completed_at)
    returning id into rid;
  else
    update public.hq_tasks as t set
      external_key = v.external_key,
      subject = v.subject,
      note = v.note,
      priority = v.priority,
      completed = v.completed,
      completed_at = v.completed_at,
      updated_at = now()
    from (select external_key, subject, note, priority, completed, completed_at) as v
    where t.id = rec.id
    returning t.id into rid;
  end if;
  perform hq_private.audit_write(p_client, p_key_id, p_action || '_task', rid::text);
  return jsonb_build_object('ok', true, 'id', rid, 'external_key', external_key, 'completed', completed);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error_code', 'conflict');
end;
$fn$;

create or replace function hq_private.note_rows(p_id uuid, p_limit int default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  cfg hq_private.owner_config%rowtype;
  cap int := least(greatest(coalesce(p_limit, 20), 1), 50);
  rec public.hq_notes%rowtype;
  rows jsonb;
begin
  select * into cfg from hq_private.owner_config where singleton = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'owner_not_configured');
  end if;
  if p_id is not null then
    select * into rec from public.hq_notes where id = p_id and owner_id = cfg.owner_id;
    if not found then
      return jsonb_build_object('ok', true, 'found', false);
    end if;
    return jsonb_build_object('ok', true, 'found', true, 'note', jsonb_build_object(
      'id', rec.id, 'external_key', rec.external_key, 'body', rec.body, 'source', rec.source,
      'status', rec.status, 'created_at', rec.created_at, 'updated_at', rec.updated_at
    ));
  end if;
  select coalesce(jsonb_agg(item order by sort_at desc), '[]'::jsonb) into rows
  from (
    select n.updated_at as sort_at, jsonb_build_object(
      'id', n.id, 'external_key', n.external_key, 'body', n.body, 'source', n.source,
      'status', n.status, 'created_at', n.created_at, 'updated_at', n.updated_at
    ) as item
    from public.hq_notes n
    where n.owner_id = cfg.owner_id
    order by n.updated_at desc
    limit cap
  ) listed;
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(rows), 'notes', rows);
end;
$fn$;

create or replace function hq_private.note_mutate(p_action text, p_body jsonb, p_client text, p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  err text;
  gate jsonb;
  owner uuid;
  rec public.hq_notes%rowtype;
  rid uuid;
  body text;
  source text;
  status text;
  external_key text;
begin
  if p_action not in ('create', 'update', 'delete') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  err := hq_private.payload_gate(p_body, case when p_action = 'delete' then array['id'] else array['id', 'external_key', 'body', 'source', 'status'] end, 20000);
  if err is not null then
    return jsonb_build_object('ok', false, 'error_code', err);
  end if;
  if p_action = 'create' and p_body ? 'id' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action in ('update', 'delete') and (not (p_body ? 'id') or (p_body->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'body' and (jsonb_typeof(p_body->'body') <> 'string' or char_length(p_body->>'body') < 1 or char_length(p_body->>'body') > 4000) then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'source' and (p_body->>'source') not in ('hq', 'conductor', 'export', 'owner') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'status' and (p_body->>'status') not in ('open', 'archived') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'external_key' and jsonb_typeof(p_body->'external_key') = 'string' and (p_body->>'external_key') !~ '^[A-Za-z0-9._:-]{1,80}$' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action = 'create' and not (p_body ? 'body') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action = 'update' and not (p_body ? 'body' or p_body ? 'source' or p_body ? 'status' or p_body ? 'external_key') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  gate := hq_private.mcp_gate(p_client, p_key_id, 'notes.write', p_action || '_note');
  if coalesce(gate->>'ok', '') <> 'true' then
    return gate;
  end if;
  owner := (gate->>'owner_id')::uuid;
  if p_action = 'delete' then
    delete from public.hq_notes where id = (p_body->>'id')::uuid and owner_id = owner returning id into rid;
    if rid is null then
      return jsonb_build_object('ok', false, 'error_code', 'not_found');
    end if;
    perform hq_private.audit_write(p_client, p_key_id, 'delete_note', rid::text);
    return jsonb_build_object('ok', true, 'id', rid, 'deleted', true);
  end if;
  if p_action = 'update' then
    select * into rec from public.hq_notes where id = (p_body->>'id')::uuid and owner_id = owner for update;
    if not found then
      return jsonb_build_object('ok', false, 'error_code', 'not_found');
    end if;
    body := case when p_body ? 'body' then p_body->>'body' else rec.body end;
    source := case when p_body ? 'source' then p_body->>'source' else rec.source end;
    status := case when p_body ? 'status' then p_body->>'status' else rec.status end;
    external_key := case
      when p_body ? 'external_key' and jsonb_typeof(p_body->'external_key') = 'null' then null
      when p_body ? 'external_key' then p_body->>'external_key'
      else rec.external_key
    end;
    update public.hq_notes as n set
      body = v.body, source = v.source, status = v.status, external_key = v.external_key, updated_at = now()
    from (select body, source, status, external_key) as v
    where n.id = rec.id
    returning n.id into rid;
  else
    body := p_body->>'body';
    source := coalesce(p_body->>'source', 'hq');
    status := coalesce(p_body->>'status', 'open');
    external_key := case when p_body ? 'external_key' and jsonb_typeof(p_body->'external_key') = 'string' then p_body->>'external_key' else null end;
    insert into public.hq_notes (owner_id, external_key, body, source, status)
    values (owner, external_key, body, source, status)
    returning id into rid;
  end if;
  perform hq_private.audit_write(p_client, p_key_id, p_action || '_note', rid::text);
  return jsonb_build_object('ok', true, 'id', rid, 'external_key', external_key, 'status', status);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error_code', 'conflict');
end;
$fn$;

create or replace function hq_private.watch_rows(p_id uuid, p_symbol text, p_bucket text, p_limit int default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  cfg hq_private.owner_config%rowtype;
  cap int := least(greatest(coalesce(p_limit, 20), 1), 50);
  rec public.watchlist%rowtype;
  rows jsonb;
begin
  if p_symbol is not null and p_symbol !~ '^[A-Z][A-Z0-9.]{0,9}$' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_bucket is not null and p_bucket not in ('holding', 'watch', 'candidate') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  select * into cfg from hq_private.owner_config where singleton = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'owner_not_configured');
  end if;
  -- A null limit with an id, or with both symbol and bucket, reads one row.
  -- A numeric limit is always a list, including limit 1.
  if p_id is not null or (p_limit is null and p_symbol is not null and p_bucket is not null) then
    if p_id is not null then
      select * into rec from public.watchlist where id = p_id and owner_id = cfg.owner_id;
    else
      select * into rec from public.watchlist where owner_id = cfg.owner_id and symbol = p_symbol and bucket = p_bucket;
    end if;
    if rec.id is null then
      return jsonb_build_object('ok', true, 'found', false);
    end if;
    return jsonb_build_object('ok', true, 'found', true, 'row', jsonb_build_object(
      'id', rec.id, 'bucket', rec.bucket, 'symbol', rec.symbol, 'asset_type', rec.asset_type,
      'source_note', rec.source_note, 'sort_order', rec.sort_order, 'as_of', rec.as_of, 'updated_at', rec.updated_at
    ));
  end if;
  select coalesce(jsonb_agg(item order by sort_order, symbol), '[]'::jsonb) into rows
  from (
    select w.sort_order, w.symbol, jsonb_build_object(
      'id', w.id, 'bucket', w.bucket, 'symbol', w.symbol, 'asset_type', w.asset_type,
      'source_note', w.source_note, 'sort_order', w.sort_order, 'as_of', w.as_of, 'updated_at', w.updated_at
    ) as item
    from public.watchlist w
    where w.owner_id = cfg.owner_id
      and (p_symbol is null or w.symbol = p_symbol)
      and (p_bucket is null or w.bucket = p_bucket)
    order by w.sort_order, w.symbol
    limit cap
  ) listed;
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(rows), 'rows', rows);
end;
$fn$;

create or replace function hq_private.watch_mutate(p_action text, p_body jsonb, p_client text, p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  err text;
  gate jsonb;
  owner uuid;
  rec public.watchlist%rowtype;
  rid uuid;
  symbol text;
  bucket text;
  asset_type text;
  source_note text;
  sort_order int;
begin
  if p_action not in ('create', 'update', 'delete') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  err := hq_private.payload_gate(p_body, case when p_action = 'delete' then array['id'] else array['id', 'symbol', 'bucket', 'asset_type', 'source_note', 'sort_order'] end, 4096);
  if err is not null then
    return jsonb_build_object('ok', false, 'error_code', err);
  end if;
  if p_action = 'create' and p_body ? 'id' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action in ('update', 'delete') and (not (p_body ? 'id') or (p_body->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'symbol' and (p_body->>'symbol') !~ '^[A-Z][A-Z0-9.]{0,9}$' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'bucket' and (p_body->>'bucket') not in ('holding', 'watch', 'candidate') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'asset_type' and jsonb_typeof(p_body->'asset_type') not in ('string', 'null') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'asset_type' and jsonb_typeof(p_body->'asset_type') = 'string' and (p_body->>'asset_type') not in ('equity', 'etf', 'fund', 'cash', 'other') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'source_note' and jsonb_typeof(p_body->'source_note') = 'string' and char_length(p_body->>'source_note') > 300 then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'sort_order' and (p_body->>'sort_order') !~ '^-?[0-9]{1,7}$' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action = 'create' and (not (p_body ? 'symbol') or not (p_body ? 'bucket')) then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action = 'update' and not (p_body ? 'symbol' or p_body ? 'bucket' or p_body ? 'asset_type' or p_body ? 'source_note' or p_body ? 'sort_order') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  gate := hq_private.mcp_gate(p_client, p_key_id, 'watchlist.write', p_action || '_watchlist');
  if coalesce(gate->>'ok', '') <> 'true' then
    return gate;
  end if;
  owner := (gate->>'owner_id')::uuid;
  if p_action = 'delete' then
    delete from public.watchlist where id = (p_body->>'id')::uuid and owner_id = owner returning id into rid;
    if rid is null then
      return jsonb_build_object('ok', false, 'error_code', 'not_found');
    end if;
    perform hq_private.audit_write(p_client, p_key_id, 'delete_watchlist', rid::text);
    return jsonb_build_object('ok', true, 'id', rid, 'deleted', true);
  end if;
  if p_action = 'update' then
    select * into rec from public.watchlist where id = (p_body->>'id')::uuid and owner_id = owner for update;
    if not found then
      return jsonb_build_object('ok', false, 'error_code', 'not_found');
    end if;
    symbol := coalesce(p_body->>'symbol', rec.symbol);
    bucket := coalesce(p_body->>'bucket', rec.bucket);
    asset_type := case
      when p_body ? 'asset_type' and jsonb_typeof(p_body->'asset_type') = 'null' then null
      when p_body ? 'asset_type' then p_body->>'asset_type'
      else rec.asset_type
    end;
    source_note := case
      when p_body ? 'source_note' and jsonb_typeof(p_body->'source_note') = 'null' then null
      when p_body ? 'source_note' then left(p_body->>'source_note', 300)
      else rec.source_note
    end;
    sort_order := case when p_body ? 'sort_order' then (p_body->>'sort_order')::int else rec.sort_order end;
  else
    symbol := p_body->>'symbol';
    bucket := p_body->>'bucket';
    asset_type := case when p_body ? 'asset_type' and jsonb_typeof(p_body->'asset_type') = 'string' then p_body->>'asset_type' else null end;
    source_note := case when p_body ? 'source_note' and jsonb_typeof(p_body->'source_note') = 'string' then left(p_body->>'source_note', 300) else null end;
    sort_order := case when p_body ? 'sort_order' then (p_body->>'sort_order')::int else 0 end;
  end if;
  if p_action = 'create' then
    insert into public.watchlist (owner_id, bucket, symbol, asset_type, source_note, sort_order, as_of)
    values (owner, bucket, symbol, asset_type, source_note, sort_order, now())
    returning id into rid;
  else
    update public.watchlist as w set
      bucket = v.bucket, symbol = v.symbol, asset_type = v.asset_type,
      source_note = v.source_note, sort_order = v.sort_order, updated_at = now()
    from (select bucket, symbol, asset_type, source_note, sort_order) as v
    where w.id = rec.id
    returning w.id into rid;
  end if;
  perform hq_private.audit_write(p_client, p_key_id, p_action || '_watchlist', rid::text);
  return jsonb_build_object('ok', true, 'id', rid, 'symbol', symbol, 'bucket', bucket);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error_code', 'conflict');
end;
$fn$;

create or replace function hq_private.plan_read(p_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  cfg hq_private.owner_config%rowtype;
  rec public.hq_plan%rowtype;
begin
  select * into cfg from hq_private.owner_config where singleton = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'owner_not_configured');
  end if;
  select * into rec from public.hq_plan where owner_id = cfg.owner_id;
  if not found or (p_id is not null and rec.id <> p_id) then
    return jsonb_build_object('ok', true, 'found', false);
  end if;
  return jsonb_build_object('ok', true, 'found', true, 'plan', jsonb_build_object(
    'id', rec.id, 'title', rec.title, 'body', rec.body, 'source', rec.source,
    'created_at', rec.created_at, 'updated_at', rec.updated_at
  ));
end;
$fn$;

create or replace function hq_private.plan_mutate(p_action text, p_body jsonb, p_client text, p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  err text;
  gate jsonb;
  owner uuid;
  rec public.hq_plan%rowtype;
  rid uuid;
  title text;
  body text;
  source text;
begin
  if p_action not in ('create', 'update') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  err := hq_private.payload_gate(p_body, array['title', 'body', 'source'], 80000);
  if err is not null then
    return jsonb_build_object('ok', false, 'error_code', err);
  end if;
  if p_body ? 'title' and (jsonb_typeof(p_body->'title') <> 'string' or char_length(btrim(p_body->>'title')) < 1 or char_length(btrim(p_body->>'title')) > 180) then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'body' and (jsonb_typeof(p_body->'body') <> 'string' or char_length(p_body->>'body') < 1 or char_length(p_body->>'body') > 65536) then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_body ? 'source' and (p_body->>'source') not in ('investment-plan.md', 'owner') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action = 'create' and (not (p_body ? 'title') or not (p_body ? 'body')) then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if p_action = 'update' and not (p_body ? 'title' or p_body ? 'body' or p_body ? 'source') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  gate := hq_private.mcp_gate(p_client, p_key_id, 'plan.write', p_action || '_plan');
  if coalesce(gate->>'ok', '') <> 'true' then
    return gate;
  end if;
  owner := (gate->>'owner_id')::uuid;
  select * into rec from public.hq_plan where owner_id = owner for update;
  if p_action = 'create' and found then
    return jsonb_build_object('ok', false, 'error_code', 'conflict');
  end if;
  if p_action = 'update' and not found then
    return jsonb_build_object('ok', false, 'error_code', 'not_found');
  end if;
  if p_action = 'create' then
    title := btrim(p_body->>'title');
    body := p_body->>'body';
    source := coalesce(p_body->>'source', 'owner');
    insert into public.hq_plan (owner_id, title, body, source)
    values (owner, title, body, source)
    returning id into rid;
  else
    title := coalesce(btrim(p_body->>'title'), rec.title);
    body := case when p_body ? 'body' then p_body->>'body' else rec.body end;
    source := case when p_body ? 'source' then p_body->>'source' else rec.source end;
    update public.hq_plan as p set
      title = v.title, body = v.body, source = v.source, updated_at = now()
    from (select title, body, source) as v
    where p.id = rec.id
    returning p.id into rid;
  end if;
  perform hq_private.audit_write(p_client, p_key_id, p_action || '_plan', rid::text);
  return jsonb_build_object('ok', true, 'id', rid, 'source', source);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error_code', 'conflict');
end;
$fn$;

create or replace function hq_private.publish_deal_audited(payload jsonb, p_client text, p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  result jsonb;
  kind text;
  need text;
  scopes text[];
begin
  kind := payload->>'kind';
  need := hq_private.deal_write_scope(kind);
  if p_client = 'oauth' and p_key_id is null then
    null;
  elsif p_client in ('grok-bot', 'claude') and p_key_id is not null and need is not null then
    select k.scopes into scopes from hq_private.publisher_keys k
      where k.id = p_key_id and k.client = p_client and k.revoked_at is null and k.expires_at > now();
    if not found or not (need = any (scopes)) then
      return jsonb_build_object('ok', false, 'error_code', 'insufficient_scope');
    end if;
  else
    return jsonb_build_object('ok', false, 'error_code', 'insufficient_scope');
  end if;
  result := hq_private.publish_deal(payload);
  if coalesce(result->>'ok', '') = 'true' and coalesce(result->>'replay', 'false') <> 'true' then
    perform hq_private.audit_write(p_client, p_key_id, 'publish_deal', coalesce(result->>'external_key', result->>'record_id'));
  end if;
  return result;
end;
$fn$;

revoke all on function hq_private.payload_gate(jsonb, text[], integer) from public, anon, authenticated;
revoke all on function hq_private.mcp_gate(text, uuid, text, text) from public, anon, authenticated;
revoke all on function hq_private.audit_write(text, uuid, text, text) from public, anon, authenticated;
revoke all on function hq_private.deal_write_scope(text) from public, anon, authenticated;
revoke all on function hq_private.deal_rows(text, text, integer, boolean) from public, anon, authenticated;
revoke all on function hq_private.deal_counts(text[]) from public, anon, authenticated;
revoke all on function hq_private.deal_mutate(text, text, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function hq_private.task_rows(uuid, integer, boolean) from public, anon, authenticated;
revoke all on function hq_private.task_mutate(text, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function hq_private.note_rows(uuid, integer) from public, anon, authenticated;
revoke all on function hq_private.note_mutate(text, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function hq_private.watch_rows(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function hq_private.watch_mutate(text, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function hq_private.plan_read(uuid) from public, anon, authenticated;
revoke all on function hq_private.plan_mutate(text, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function hq_private.publish_deal_audited(jsonb, text, uuid) from public, anon, authenticated;

grant execute on function hq_private.deal_rows(text, text, integer, boolean) to hq_publisher;
grant execute on function hq_private.deal_counts(text[]) to hq_publisher;
grant execute on function hq_private.deal_mutate(text, text, jsonb, text, uuid) to hq_publisher;
grant execute on function hq_private.task_rows(uuid, integer, boolean) to hq_publisher;
grant execute on function hq_private.task_mutate(text, jsonb, text, uuid) to hq_publisher;
grant execute on function hq_private.note_rows(uuid, integer) to hq_publisher;
grant execute on function hq_private.note_mutate(text, jsonb, text, uuid) to hq_publisher;
grant execute on function hq_private.watch_rows(uuid, text, text, integer) to hq_publisher;
grant execute on function hq_private.watch_mutate(text, jsonb, text, uuid) to hq_publisher;
grant execute on function hq_private.plan_read(uuid) to hq_publisher;
grant execute on function hq_private.plan_mutate(text, jsonb, text, uuid) to hq_publisher;
grant execute on function hq_private.publish_deal_audited(jsonb, text, uuid) to hq_publisher;

comment on function hq_private.deal_mutate(text, text, jsonb, text, uuid) is
  'Create or update one listing, pipeline, or escrow row for the bound owner. Archive sets archived_at. There is no delete. Owner and scopes come from owner_config and the publisher key, not from the caller.';
comment on function hq_private.publish_deal_audited(jsonb, text, uuid) is
  'Calls publish_deal and writes an audit row. OAuth passes client oauth and a null key. A publisher key must hold the write scope for the record kind. instinct is rejected.';

do $$
declare
  full_scopes text[] := array[
    'research.publish', 'research.status.read', 'research.read',
    'listings.read', 'listings.write',
    'pipeline.read', 'pipeline.write',
    'escrow.read', 'escrow.write',
    'tasks.read', 'tasks.write',
    'notes.read', 'notes.write',
    'watchlist.read', 'watchlist.write',
    'plan.read', 'plan.write'
  ];
  client_check text;
  issue_src text;
begin
  if hq_private.publisher_key_default_scopes('grok-bot') is distinct from full_scopes
     or hq_private.publisher_key_default_scopes('claude') is distinct from full_scopes then
    raise exception 'postcondition abort: full client scopes';
  end if;
  if hq_private.publisher_key_default_scopes('instinct') is distinct from array['research.status.read', 'research.read']::text[] then
    raise exception 'postcondition abort: instinct scopes changed';
  end if;
  select pg_get_constraintdef(oid) into client_check
  from pg_constraint
  where conname = 'publisher_keys_client_scopes'
    and conrelid = 'hq_private.publisher_keys'::regclass;
  if client_check is null or position('listings.write' in client_check) = 0 or position('instinct' in client_check) = 0 then
    raise exception 'postcondition abort: client scope check';
  end if;
  if position('listings' in (
    select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'hq_private.publisher_keys'::regclass and conname = 'publisher_keys_client_scopes'
      and pg_get_constraintdef(oid) like '%instinct%'
  )) > 0 and position('listings.write' in substring(client_check from 'instinct.{0,180}')) > 0 then
    raise exception 'postcondition abort: instinct check mentions listing write';
  end if;
  select pg_get_functiondef('hq_private.publisher_key_issue(text,text,text)'::regprocedure) into issue_src;
  if position('publisher_key_default_scopes' in issue_src) = 0 then
    raise exception 'postcondition abort: issuer no longer reads default scopes';
  end if;
  if exists (
    select 1
    from publisher_keys_snapshot b
    full outer join hq_private.publisher_keys k on k.id = b.id
    where b.id is null or k.id is null
       or b.client is distinct from k.client
       or b.label is distinct from k.label
       or b.key_hash is distinct from k.key_hash
       or b.scopes is distinct from k.scopes
       or b.created_at is distinct from k.created_at
       or b.expires_at is distinct from k.expires_at
       or b.revoked_at is distinct from k.revoked_at
       or b.last_used_at is distinct from k.last_used_at
  ) then
    raise exception 'postcondition abort: existing publisher_keys rows changed';
  end if;
  if (select count(*) from public.hq_tasks) <> 0
     or (select count(*) from public.hq_notes) <> 0
     or (select count(*) from public.hq_plan) <> 0
     or (select count(*) from hq_private.mcp_audit) <> 0 then
    raise exception 'postcondition abort: domain tables must start empty';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'deal_records' and column_name = 'archived_at'
  ) then
    raise exception 'postcondition abort: archived_at missing';
  end if;
  if has_table_privilege('hq_publisher', 'public.hq_tasks', 'select')
     or has_table_privilege('hq_publisher', 'public.hq_tasks', 'insert')
     or has_table_privilege('hq_publisher', 'public.hq_notes', 'delete')
     or has_table_privilege('hq_publisher', 'public.hq_plan', 'update')
     or has_table_privilege('hq_publisher', 'hq_private.mcp_audit', 'insert')
     or has_table_privilege('hq_publisher', 'public.deal_records', 'delete')
     or has_table_privilege('anon', 'public.hq_tasks', 'select')
     or not has_table_privilege('authenticated', 'public.hq_tasks', 'insert')
     or not has_table_privilege('authenticated', 'public.hq_tasks', 'delete')
     or has_table_privilege('authenticated', 'public.hq_plan', 'delete')
     or not has_function_privilege('hq_publisher', 'hq_private.task_mutate(text, jsonb, text, uuid)', 'execute')
     or has_function_privilege('anon', 'hq_private.task_mutate(text, jsonb, text, uuid)', 'execute')
     or has_function_privilege('authenticated', 'hq_private.deal_mutate(text, text, jsonb, text, uuid)', 'execute')
     or not has_function_privilege('hq_publisher', 'hq_private.publish_deal_audited(jsonb, text, uuid)', 'execute')
     or not has_function_privilege('hq_publisher', 'hq_private.publisher_key_check(text)', 'execute') then
    raise exception 'postcondition abort: grants';
  end if;
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'hq_private'
      and p.proname in ('deal_mutate', 'task_mutate', 'note_mutate', 'watch_mutate', 'plan_mutate', 'publish_deal_audited', 'mcp_gate', 'publisher_key_check')
      and p.prosecdef is not true
  ) then
    raise exception 'postcondition abort: writer must stay security definer';
  end if;
end $$;
