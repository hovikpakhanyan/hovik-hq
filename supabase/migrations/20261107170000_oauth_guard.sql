-- NOT APPLIED. Requires the oauth token migration. Adds abuse throttling and retention.
-- Does not alter listings, escrows, tasks, or notes. No table privileges for hq_publisher.

do $$ begin
  if to_regclass('hq_private.oauth_family') is null then
    raise exception 'preflight abort: oauth token tables are missing';
  end if;
  if to_regclass('hq_private.oauth_throttle') is not null then
    raise exception 'preflight abort: oauth throttle already exists';
  end if;
end $$;

create table hq_private.oauth_throttle (
  bucket text primary key,
  hits int not null,
  window_start timestamptz not null
);

create or replace function hq_private.oauth_hit(p_bucket text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = hq_private, pg_temp
as $fn$
declare
  current hq_private.oauth_throttle%rowtype;
begin
  if p_bucket is null or char_length(p_bucket) < 1 or char_length(p_bucket) > 200
     or p_limit < 1 or p_window_seconds < 1 then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtext('hq_oauth_hit:' || p_bucket));
  select * into current from hq_private.oauth_throttle where bucket = p_bucket for update;
  if not found or current.window_start <= now() - (p_window_seconds * interval '1 second') then
    insert into hq_private.oauth_throttle (bucket, hits, window_start)
    values (p_bucket, 1, now())
    on conflict (bucket) do update set hits = 1, window_start = now();
    return true;
  end if;
  if current.hits >= p_limit then
    return false;
  end if;
  update hq_private.oauth_throttle set hits = current.hits + 1 where bucket = p_bucket;
  return true;
end;
$fn$;

create or replace function hq_private.oauth_purge_expired()
returns void
language plpgsql
security definer
set search_path = hq_private, pg_temp
as $fn$
begin
  delete from hq_private.oauth_codes
    where expires_at < now()
       or (used_at is not null and used_at < now() - interval '1 hour');
  delete from hq_private.oauth_access
    where expires_at < now();
  delete from hq_private.oauth_refresh
    where expires_at < now();
  delete from hq_private.oauth_family as family
    where family.revoked
      and not exists (select 1 from hq_private.oauth_access as access where access.family_id = family.family_id)
      and not exists (select 1 from hq_private.oauth_refresh as refresh where refresh.family_id = family.family_id);
  delete from hq_private.oauth_throttle
    where window_start < now() - interval '1 day';
end;
$fn$;

revoke all on function hq_private.oauth_hit(text, int, int) from public, anon, authenticated;
revoke all on function hq_private.oauth_purge_expired() from public, anon, authenticated;
grant execute on function hq_private.oauth_hit(text, int, int) to hq_publisher;
grant execute on function hq_private.oauth_purge_expired() to hq_publisher;

comment on function hq_private.oauth_hit(text, int, int) is
  'Counts one authorize or token attempt. hq_publisher cannot read the token tables.';
comment on function hq_private.oauth_purge_expired() is
  'Deletes expired codes, access tokens, and refresh tokens. A consumed refresh token stays until it expires so reuse can still revoke the family.';
