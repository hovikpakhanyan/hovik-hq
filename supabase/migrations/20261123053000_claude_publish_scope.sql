-- NOT APPLIED by this repository change. Requires
-- 20261122170000_publisher_keys.sql. Does not edit that file.
--
-- New claude keys are issued with research.publish, research.status.read,
-- and research.read. grok-bot and instinct defaults stay as they are.
-- publisher_keys_scopes_known is unchanged, so a row still cannot hold a
-- deal, listing, pipeline, or escrow scope. Existing publisher_keys rows
-- are not updated. Does not touch 20261111223000_deal_publisher.sql.

do $$ begin
  if to_regclass('hq_private.publisher_keys') is null
     or to_regprocedure('hq_private.publisher_key_issue(text, text, text)') is null
     or to_regprocedure('hq_private.publisher_key_default_scopes(text)') is null then
    raise exception 'preflight abort: publisher key migration is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'publisher_keys_client_scopes'
      and conrelid = 'hq_private.publisher_keys'::regclass
  ) or not exists (
    select 1 from pg_constraint
    where conname = 'publisher_keys_scopes_known'
      and conrelid = 'hq_private.publisher_keys'::regclass
  ) then
    raise exception 'preflight abort: publisher key scope checks are missing';
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
      (p.proname = 'publisher_key_issue' and pg_get_function_identity_arguments(p.oid) = 'p_hash text, p_client text, p_label text')
      or (p.proname = 'publisher_key_default_scopes' and pg_get_function_identity_arguments(p.oid) = 'p_client text')
    );

create temporary table publisher_scopes_known_def as
  select pg_get_constraintdef(oid) as def
  from pg_constraint
  where conname = 'publisher_keys_scopes_known'
    and conrelid = 'hq_private.publisher_keys'::regclass;

alter table hq_private.publisher_keys drop constraint publisher_keys_client_scopes;
alter table hq_private.publisher_keys add constraint publisher_keys_client_scopes check (
  (client = 'grok-bot' and scopes <@ array['research.publish', 'research.status.read']::text[])
  or (client = 'claude' and scopes <@ array['research.publish', 'research.status.read', 'research.read']::text[])
  or (client = 'instinct' and scopes <@ array['research.status.read', 'research.read']::text[])
);

-- The issuer reads this function. Replace it so a new claude key gets publish.
create or replace function hq_private.publisher_key_default_scopes(p_client text)
returns text[]
language sql
immutable
set search_path = hq_private, pg_temp
as $$
  select case p_client
    when 'grok-bot' then array['research.publish', 'research.status.read']::text[]
    when 'claude' then array['research.publish', 'research.status.read', 'research.read']::text[]
    when 'instinct' then array['research.status.read', 'research.read']::text[]
    else null
  end;
$$;

-- Same signature, security definer, and search_path as the original issuer.
-- Scopes still come from publisher_key_default_scopes, not from the caller.
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

do $$
declare
  rec record;
begin
  for rec in select proname, rolname from publisher_fn_owners loop
    if rec.proname = 'publisher_key_issue' then
      execute format('alter function hq_private.publisher_key_issue(text, text, text) owner to %I', rec.rolname);
    elsif rec.proname = 'publisher_key_default_scopes' then
      execute format('alter function hq_private.publisher_key_default_scopes(text) owner to %I', rec.rolname);
    end if;
  end loop;
end $$;

revoke all on function hq_private.publisher_key_default_scopes(text) from public, anon, authenticated;
revoke all on function hq_private.publisher_key_issue(text, text, text) from public, anon, authenticated;
grant execute on function hq_private.publisher_key_issue(text, text, text) to hq_publisher;

comment on function hq_private.publisher_key_issue(text, text, text) is
  'Called by the owner-gated /publisher/keys page. Scopes and the 90-day expiry come from the database, not the caller.';

do $$
declare
  known text;
  client_check text;
  issue_owner name;
  default_owner name;
  issue_sec boolean;
  issue_config text[];
begin
  if hq_private.publisher_key_default_scopes('claude')
     is distinct from array['research.publish', 'research.status.read', 'research.read']::text[] then
    raise exception 'postcondition abort: claude default scopes';
  end if;
  if hq_private.publisher_key_default_scopes('grok-bot')
     is distinct from array['research.publish', 'research.status.read']::text[] then
    raise exception 'postcondition abort: grok-bot default scopes';
  end if;
  if hq_private.publisher_key_default_scopes('instinct')
     is distinct from array['research.status.read', 'research.read']::text[] then
    raise exception 'postcondition abort: instinct default scopes';
  end if;

  select def into known from publisher_scopes_known_def;
  if known is distinct from (
    select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'publisher_keys_scopes_known'
      and conrelid = 'hq_private.publisher_keys'::regclass
  ) then
    raise exception 'postcondition abort: publisher_keys_scopes_known changed';
  end if;

  select pg_get_constraintdef(oid) into client_check
  from pg_constraint
  where conname = 'publisher_keys_client_scopes'
    and conrelid = 'hq_private.publisher_keys'::regclass;
  if client_check is null
     or position('deal' in client_check) > 0
     or position('listing' in client_check) > 0
     or position('pipeline' in client_check) > 0
     or position('escrow' in client_check) > 0 then
    raise exception 'postcondition abort: client scope check';
  end if;

  select prosecdef, proconfig, r.rolname
    into issue_sec, issue_config, issue_owner
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'hq_private' and p.proname = 'publisher_key_issue'
    and pg_get_function_identity_arguments(p.oid) = 'p_hash text, p_client text, p_label text';
  select rolname into default_owner from publisher_fn_owners where proname = 'publisher_key_default_scopes';
  if issue_sec is not true then
    raise exception 'postcondition abort: publisher_key_issue must stay security definer';
  end if;
  if issue_owner is distinct from (select rolname from publisher_fn_owners where proname = 'publisher_key_issue') then
    raise exception 'postcondition abort: publisher_key_issue owner changed';
  end if;
  if (select r.rolname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_roles r on r.oid = p.proowner
      where n.nspname = 'hq_private' and p.proname = 'publisher_key_default_scopes'
        and pg_get_function_identity_arguments(p.oid) = 'p_client text')
     is distinct from default_owner then
    raise exception 'postcondition abort: publisher_key_default_scopes owner changed';
  end if;
  if not exists (
    select 1 from unnest(coalesce(issue_config, array[]::text[])) cfg
    where cfg like 'search_path=%hq_private%' and cfg like '%pg_temp%'
  ) then
    raise exception 'postcondition abort: publisher_key_issue search_path';
  end if;

  if has_function_privilege('anon', 'hq_private.publisher_key_issue(text, text, text)', 'execute')
     or has_function_privilege('authenticated', 'hq_private.publisher_key_issue(text, text, text)', 'execute')
     or not has_function_privilege('hq_publisher', 'hq_private.publisher_key_issue(text, text, text)', 'execute')
     or has_function_privilege('anon', 'hq_private.publisher_key_default_scopes(text)', 'execute')
     or has_function_privilege('authenticated', 'hq_private.publisher_key_default_scopes(text)', 'execute')
     or has_function_privilege('hq_publisher', 'hq_private.publisher_key_default_scopes(text)', 'execute') then
    raise exception 'postcondition abort: publisher key function grants';
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
end $$;
