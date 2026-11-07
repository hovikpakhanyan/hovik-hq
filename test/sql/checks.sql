insert into hq_private.owner_config (singleton, owner_id, project_ref)
values (1, '11111111-1111-1111-1111-111111111111', 'zjsvrfudkigjvvhlehdh');
insert into hq_private.instrument_allowlist (symbol, asset_type, verification_state, publishable)
values ('NVDA', 'equity', 'verified', true);

do $t$
declare
  result jsonb;
  good jsonb;
  stamp text := to_char(now() at time zone 'utc' - interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  source_stamp text := to_char(now() at time zone 'utc' - interval '40 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  result := hq_private.publish_stock_research(jsonb_build_object(
    'schema_version', 1, 'run_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'researched_at', stamp, 'outcome', 'publish', 'owner_id', '22222222-2222-2222-2222-222222222222', 'findings', '[]'::jsonb
  ));
  if result->>'error_code' <> 'forbidden_field' then
    raise exception 'owner field was accepted: %', result;
  end if;

  good := jsonb_build_object(
    'schema_version', 1, 'run_id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'researched_at', stamp, 'outcome', 'publish',
    'findings', jsonb_build_array(jsonb_build_object(
      'finding_key', 'n1', 'category', 'company_news', 'horizon', 'short', 'risk', 'high', 'symbol', 'NVDA',
      'title', 'Chip note', 'summary', 'Sourced note',
      'sources', jsonb_build_array(jsonb_build_object('label', 'Wire', 'url', 'https://news.example/n', 'published_at', source_stamp))
    ))
  );
  result := hq_private.publish_stock_research(good);
  if result->>'ok' <> 'true' then
    raise exception 'publish failed: %', result;
  end if;

  result := hq_private.publish_stock_research(good);
  if result->>'replay' <> 'true' then
    raise exception 'replay missing: %', result;
  end if;
  if (select count(*) from public.research_findings) <> 1 then
    raise exception 'replay duplicated findings';
  end if;

  result := hq_private.publish_stock_research('{"schema_version":1,"run_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","researched_at":"2026-11-07T18:10:00Z","outcome":"publish","findings":[{"finding_key":"n2","category":"company_news","horizon":"long","risk":"baseline","symbol":"NVDA","title":"Other","summary":"Other","sources":[{"label":"Wire","url":"https://news.example/o","published_at":"2026-11-07T17:00:00Z"}]}]}'::jsonb);
  if result->>'error_code' <> 'replay_conflict' then
    raise exception 'conflict not rejected: %', result;
  end if;

  result := hq_private.publish_stock_research(jsonb_build_object(
    'schema_version', 1,
    'run_id', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'researched_at', to_char(now() at time zone 'utc' - interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'outcome', 'no_change'
  ));
  if result->>'error_code' <> 'stale_run' then
    raise exception 'stale run replaced state: %', result;
  end if;
  if (select count(*) from public.research_findings) <> 1 then
    raise exception 'last good was not preserved';
  end if;

  result := hq_private.publish_stock_research(jsonb_build_object(
    'schema_version', 1,
    'run_id', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    'researched_at', to_char(now() at time zone 'utc' - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'outcome', 'publish',
    'findings', jsonb_build_array(jsonb_build_object(
      'finding_key', 'bad', 'category', 'world_events', 'horizon', 'trend', 'risk', 'baseline',
      'title', 'X', 'summary', 'Y',
      'sources', jsonb_build_array(jsonb_build_object('label', 'js', 'url', 'javascript:alert(1)', 'published_at', to_char(now() at time zone 'utc' - interval '10 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
    ))
  ));
  if result->>'error_code' <> 'bad_url' then
    raise exception 'bad url accepted: %', result;
  end if;
  if (select count(*) from public.research_findings) <> 1 then
    raise exception 'invalid batch cleared last good';
  end if;
  if (hq_private.research_status(null)->>'ok') <> 'true' then
    raise exception 'status failed';
  end if;
end
$t$;

set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
do $t$
begin
  if (select count(*) from public.research_findings) <> 0 then
    raise exception 'other user can read findings';
  end if;
end
$t$;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
do $t$
begin
  if (select count(*) from public.research_findings) <> 1 then
    raise exception 'owner cannot read own finding';
  end if;
  begin
    insert into public.watchlist (owner_id, bucket, symbol)
    values ('11111111-1111-1111-1111-111111111111', 'holding', 'NVDA');
    raise exception 'authenticated insert was allowed';
  exception when insufficient_privilege then
    null;
  end;
end
$t$;

set role anon;
do $t$
begin
  perform 1 from public.research_findings;
  raise exception 'anon read was allowed';
exception when insufficient_privilege then
  null;
end
$t$;
