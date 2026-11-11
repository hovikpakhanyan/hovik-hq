-- NOT APPLIED by this repository change. Review and run only after the owner
-- approves it. Does not ALTER listings, escrows, tasks, or notes, and does not
-- seed rows, addresses, prices, or owner ids.
--
-- hq_publisher already exists from the research publisher migration. This file
-- aborts if that role or hq_private.is_bound_owner() is missing. It does not
-- change OAuth scopes, secrets, or the research tables.
--
-- The browser never receives a service-role key. anon and authenticated cannot
-- execute the writer. Authenticated can only select its own rows after the
-- bound-owner check. Direct writes from the HQ page are not granted.

do $$ begin
  if to_regclass('public.deal_records') is not null
     or to_regclass('hq_private.deal_publications') is not null
     or to_regclass('hq_private.deal_attempts') is not null
     or to_regprocedure('hq_private.publish_deal(jsonb)') is not null then
    raise exception 'preflight abort: deal publisher objects already exist';
  end if;
  if to_regprocedure('hq_private.is_bound_owner()') is null
     or to_regprocedure('hq_private.json_forbidden(jsonb)') is null then
    raise exception 'preflight abort: research publisher functions are missing';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hq_publisher') then
    raise exception 'preflight abort: hq_publisher is missing';
  end if;
end $$;

create table hq_private.deal_attempts (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  record_id uuid,
  at timestamptz not null default now()
);

create table hq_private.deal_publications (
  record_id uuid primary key,
  owner_id uuid not null,
  external_key text not null,
  payload_hash text not null,
  received_at timestamptz not null default now()
);

create table public.deal_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  external_key text not null check (external_key ~ '^[A-Za-z0-9._:-]{1,80}$'),
  kind text not null check (kind in ('listing', 'pipeline', 'escrow')),
  lane text not null check (lane in ('current', 'upcoming', 'sold', 'pipeline', 'escrow')),
  title text not null check (char_length(title) between 1 and 180),
  status_label text not null check (char_length(status_label) between 1 and 80),
  price_cents bigint check (price_cents is null or (price_cents >= 0 and price_cents <= 900000000000000)),
  net_est_cents bigint check (net_est_cents is null or (net_est_cents >= 0 and net_est_cents <= 900000000000000)),
  closed_on date,
  note text check (note is null or char_length(note) <= 2000),
  source_updated_at timestamptz not null,
  updated_at timestamptz not null default now(),
  unique (owner_id, external_key),
  check (
    (kind = 'listing' and lane in ('current', 'upcoming', 'sold'))
    or (kind = 'pipeline' and lane = 'pipeline')
    or (kind = 'escrow' and lane = 'escrow')
  ),
  check (closed_on is null or lane = 'sold')
);

create index deal_records_owner_idx on public.deal_records (owner_id, kind, lane);

alter table hq_private.deal_attempts enable row level security;
alter table hq_private.deal_publications enable row level security;
alter table public.deal_records enable row level security;
alter table hq_private.deal_attempts force row level security;
alter table hq_private.deal_publications force row level security;
alter table public.deal_records force row level security;

create policy owner_select on public.deal_records for select to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner());

revoke all on table hq_private.deal_attempts from public, anon, authenticated, hq_publisher;
revoke all on table hq_private.deal_publications from public, anon, authenticated, hq_publisher;
revoke all on table public.deal_records from public, anon, authenticated;
grant select on table public.deal_records to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on table public.deal_records from service_role';
    execute 'revoke all on table hq_private.deal_attempts from service_role';
    execute 'revoke all on table hq_private.deal_publications from service_role';
  end if;
end $$;

create or replace function hq_private.publish_deal(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = hq_private, public, pg_temp
as $fn$
declare
  cfg hq_private.owner_config%rowtype;
  rid uuid;
  key text;
  kind text;
  lane text;
  title text;
  status_label text;
  note text;
  price bigint;
  net bigint;
  closed date;
  source_at timestamptz;
  hash text;
  bad text;
  existing hq_private.deal_publications%rowtype;
  attempts int;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if octet_length(payload::text) > 65536 then
    return jsonb_build_object('ok', false, 'error_code', 'oversize');
  end if;

  select * into cfg from hq_private.owner_config where singleton = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'owner_not_configured');
  end if;

  bad := hq_private.json_forbidden(payload);
  if bad is not null then
    return jsonb_build_object('ok', false, 'error_code', 'forbidden_field', 'field', bad);
  end if;

  begin
    if (payload->>'schema_version')::int <> 1 then
      return jsonb_build_object('ok', false, 'error_code', 'bad_version');
    end if;
    rid := (payload->>'record_id')::uuid;
    source_at := (payload->>'updated_at')::timestamptz;
  exception when others then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end;

  key := btrim(payload->>'external_key');
  kind := payload->>'kind';
  lane := payload->>'lane';
  title := btrim(payload->>'title');
  status_label := btrim(payload->>'status_label');
  note := payload->>'note';

  if rid is null or key is null or key !~ '^[A-Za-z0-9._:-]{1,80}$' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if kind not in ('listing', 'pipeline', 'escrow') or lane is null then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if kind = 'listing' and lane not in ('current', 'upcoming', 'sold') then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if kind = 'pipeline' and lane <> 'pipeline' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if kind = 'escrow' and lane <> 'escrow' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if title is null or char_length(title) < 1 or char_length(title) > 180
     or status_label is null or char_length(status_label) < 1 or char_length(status_label) > 80 then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
  end if;
  if note is not null and char_length(note) > 2000 then
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

  price := null;
  net := null;
  closed := null;
  if payload ? 'price_cents' and jsonb_typeof(payload->'price_cents') <> 'null' then
    if (payload->>'price_cents') !~ '^[0-9]{1,15}$' then
      return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
    end if;
    price := (payload->>'price_cents')::bigint;
  end if;
  if payload ? 'net_est_cents' and jsonb_typeof(payload->'net_est_cents') <> 'null' then
    if (payload->>'net_est_cents') !~ '^[0-9]{1,15}$' then
      return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
    end if;
    net := (payload->>'net_est_cents')::bigint;
  end if;
  if payload ? 'closed_on' and coalesce(payload->>'closed_on', '') <> '' then
    if lane <> 'sold' or (payload->>'closed_on') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
    end if;
    begin
      closed := (payload->>'closed_on')::date;
    exception when others then
      return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
    end;
    if to_char(closed, 'YYYY-MM-DD') <> payload->>'closed_on' then
      return jsonb_build_object('ok', false, 'error_code', 'invalid_payload');
    end if;
  end if;

  hash := md5(payload::text);
  perform pg_advisory_xact_lock(hashtext('hq_deal_publish'));

  select * into existing from hq_private.deal_publications where record_id = rid;
  if found then
    if existing.owner_id <> cfg.owner_id or existing.payload_hash <> hash then
      return jsonb_build_object('ok', false, 'error_code', 'replay_conflict', 'record_id', rid);
    end if;
    return jsonb_build_object('ok', true, 'replay', true, 'record_id', rid, 'external_key', existing.external_key);
  end if;

  select count(*) into attempts from hq_private.deal_attempts
    where owner_id = cfg.owner_id and at > now() - interval '1 hour';
  if attempts >= 30 then
    return jsonb_build_object('ok', false, 'error_code', 'rate_limited');
  end if;
  insert into hq_private.deal_attempts (owner_id, record_id) values (cfg.owner_id, rid);

  insert into public.deal_records (
    owner_id, external_key, kind, lane, title, status_label,
    price_cents, net_est_cents, closed_on, note, source_updated_at
  ) values (
    cfg.owner_id, key, kind, lane, title, status_label, price, net, closed, nullif(note, ''), source_at
  )
  on conflict (owner_id, external_key) do update set
    kind = excluded.kind,
    lane = excluded.lane,
    title = excluded.title,
    status_label = excluded.status_label,
    price_cents = excluded.price_cents,
    net_est_cents = excluded.net_est_cents,
    closed_on = excluded.closed_on,
    note = excluded.note,
    source_updated_at = excluded.source_updated_at,
    updated_at = now();

  insert into hq_private.deal_publications (record_id, owner_id, external_key, payload_hash)
  values (rid, cfg.owner_id, key, hash);

  return jsonb_build_object(
    'ok', true,
    'replay', false,
    'record_id', rid,
    'external_key', key,
    'kind', kind,
    'lane', lane
  );
exception when others then
  raise;
end;
$fn$;

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
        'source_updated_at', rec.source_updated_at
      )
    );
  end if;
  return jsonb_build_object(
    'ok', true,
    'configured', true,
    'counts', jsonb_build_object(
      'listing', (select count(*) from public.deal_records where owner_id = cfg.owner_id and kind = 'listing'),
      'pipeline', (select count(*) from public.deal_records where owner_id = cfg.owner_id and kind = 'pipeline'),
      'escrow', (select count(*) from public.deal_records where owner_id = cfg.owner_id and kind = 'escrow')
    )
  );
end;
$fn$;

revoke all on function hq_private.publish_deal(jsonb) from public, anon, authenticated;
revoke all on function hq_private.deal_status(text) from public, anon, authenticated;
grant execute on function hq_private.publish_deal(jsonb) to hq_publisher;
grant execute on function hq_private.deal_status(text) to hq_publisher;

comment on function hq_private.publish_deal(jsonb) is
  'Restricted writer for listing, pipeline, and escrow records. Owner comes from hq_private.owner_config. Caller-supplied owner_id, destination, SQL, secrets, and quote fields are rejected. Amounts are integer cents on the record, not market quotes. Not granted to anon, authenticated, or the browser.';
