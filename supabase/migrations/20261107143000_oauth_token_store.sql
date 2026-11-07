-- NOT APPLIED. Requires the research migration first. Stores only hashes.
-- Does not alter listings, escrows, tasks, or notes.

do $$ begin
  if to_regnamespace('hq_private') is null then
    raise exception 'preflight abort: hq_private is missing';
  end if;
  if to_regclass('hq_private.oauth_access') is not null
     or to_regclass('hq_private.oauth_refresh') is not null
     or to_regclass('hq_private.oauth_codes') is not null
     or to_regclass('hq_private.oauth_family') is not null then
    raise exception 'preflight abort: oauth token objects already exist';
  end if;
end $$;

create table hq_private.oauth_family (
  family_id uuid primary key,
  revoked boolean not null default false
);

create table hq_private.oauth_codes (
  code_hash text primary key,
  client_id text not null,
  redirect_uri text not null,
  challenge text not null,
  scope text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table hq_private.oauth_refresh (
  token_hash text primary key,
  family_id uuid not null references hq_private.oauth_family (family_id),
  scope text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create table hq_private.oauth_access (
  token_hash text primary key,
  family_id uuid not null references hq_private.oauth_family (family_id),
  scope text not null,
  expires_at timestamptz not null
);

create or replace function hq_private.oauth_save_code(
  p_hash text, p_client text, p_redirect text, p_challenge text, p_scope text, p_expires timestamptz
) returns void
language sql
security definer
set search_path = hq_private, pg_temp
as $$
  insert into hq_private.oauth_codes (code_hash, client_id, redirect_uri, challenge, scope, expires_at)
  values (p_hash, p_client, p_redirect, p_challenge, p_scope, p_expires);
$$;

create or replace function hq_private.oauth_consume_code(p_hash text)
returns table (client_id text, redirect_uri text, challenge text, scope text, expires_at timestamptz)
language plpgsql
security definer
set search_path = hq_private, pg_temp
as $fn$
declare
  row hq_private.oauth_codes%rowtype;
begin
  select * into row from hq_private.oauth_codes where code_hash = p_hash for update;
  if not found or row.used_at is not null or row.expires_at <= now() then
    return;
  end if;
  update hq_private.oauth_codes set used_at = now() where code_hash = p_hash;
  return query select row.client_id, row.redirect_uri, row.challenge, row.scope, row.expires_at;
end;
$fn$;

create or replace function hq_private.oauth_save_grant(
  p_access text, p_refresh text, p_family uuid, p_scope text, p_access_exp timestamptz, p_refresh_exp timestamptz
) returns void
language plpgsql
security definer
set search_path = hq_private, pg_temp
as $fn$
begin
  insert into hq_private.oauth_family (family_id) values (p_family)
  on conflict (family_id) do nothing;
  insert into hq_private.oauth_access (token_hash, family_id, scope, expires_at)
  values (p_access, p_family, p_scope, p_access_exp);
  insert into hq_private.oauth_refresh (token_hash, family_id, scope, expires_at)
  values (p_refresh, p_family, p_scope, p_refresh_exp);
end;
$fn$;

create or replace function hq_private.oauth_rotate(
  p_old text, p_access text, p_refresh text, p_access_exp timestamptz, p_refresh_exp timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = hq_private, pg_temp
as $fn$
declare
  current hq_private.oauth_refresh%rowtype;
  family hq_private.oauth_family%rowtype;
begin
  select * into current from hq_private.oauth_refresh where token_hash = p_old for update;
  if not found then
    return jsonb_build_object('ok', false);
  end if;
  select * into family from hq_private.oauth_family where family_id = current.family_id for update;
  if family.revoked or current.consumed_at is not null or current.expires_at <= now() then
    update hq_private.oauth_family set revoked = true where family_id = current.family_id;
    delete from hq_private.oauth_access where family_id = current.family_id;
    return jsonb_build_object('ok', false);
  end if;
  update hq_private.oauth_refresh set consumed_at = now() where token_hash = p_old;
  insert into hq_private.oauth_access (token_hash, family_id, scope, expires_at)
  values (p_access, current.family_id, current.scope, p_access_exp);
  insert into hq_private.oauth_refresh (token_hash, family_id, scope, expires_at)
  values (p_refresh, current.family_id, current.scope, p_refresh_exp);
  return jsonb_build_object('ok', true, 'scope', current.scope, 'family', current.family_id);
end;
$fn$;

create or replace function hq_private.oauth_introspect(p_access text)
returns text
language sql
stable
security definer
set search_path = hq_private, pg_temp
as $$
  select a.scope
  from hq_private.oauth_access a
  join hq_private.oauth_family f on f.family_id = a.family_id
  where a.token_hash = p_access and a.expires_at > now() and f.revoked = false;
$$;

create or replace function hq_private.oauth_revoke(p_hash text)
returns void
language plpgsql
security definer
set search_path = hq_private, pg_temp
as $fn$
declare
  family uuid;
begin
  select family_id into family from hq_private.oauth_access where token_hash = p_hash;
  if family is null then
    select family_id into family from hq_private.oauth_refresh where token_hash = p_hash;
  end if;
  if family is null then
    return;
  end if;
  update hq_private.oauth_family set revoked = true where family_id = family;
  delete from hq_private.oauth_access where family_id = family;
end;
$fn$;

revoke all on function hq_private.oauth_save_code(text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function hq_private.oauth_consume_code(text) from public, anon, authenticated;
revoke all on function hq_private.oauth_save_grant(text, text, uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function hq_private.oauth_rotate(text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function hq_private.oauth_introspect(text) from public, anon, authenticated;
revoke all on function hq_private.oauth_revoke(text) from public, anon, authenticated;
grant execute on function hq_private.oauth_save_code(text, text, text, text, text, timestamptz) to hq_publisher;
grant execute on function hq_private.oauth_consume_code(text) to hq_publisher;
grant execute on function hq_private.oauth_save_grant(text, text, uuid, text, timestamptz, timestamptz) to hq_publisher;
grant execute on function hq_private.oauth_rotate(text, text, text, timestamptz, timestamptz) to hq_publisher;
grant execute on function hq_private.oauth_introspect(text) to hq_publisher;
grant execute on function hq_private.oauth_revoke(text) to hq_publisher;
