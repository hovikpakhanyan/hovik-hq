-- Local fixture only. Not production.
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

\ir ../../supabase/migrations/20261107120000_research_publisher.sql

insert into hq_private.owner_config (singleton, owner_id, project_ref)
values (1, '11111111-1111-1111-1111-111111111111', 'zjsvrfudkigjvvhlehdh');
insert into hq_private.instrument_allowlist (symbol, asset_type, verification_state, publishable)
values ('NVDA', 'equity', 'verified', true);

select set_config('role', 'hq_publisher', true);

-- unauthenticated / missing session cannot execute as authenticated
set role authenticated;
select hq_private.is_bound_owner() as stranger_before_jwt \gset
\if :stranger_before_jwt
\echo FAIL stranger matched
\quit 1
\endif

set role hq_publisher;
select (hq_private.publish_stock_research('{"schema_version":1,"run_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","researched_at":"2026-11-07T18:00:00Z","outcome":"publish","owner_id":"22222222-2222-2222-2222-222222222222","findings":[]}'::jsonb)->>'error_code') = 'forbidden_field' as reject_owner \gset
\if :reject_owner
\else
\echo FAIL owner field
\quit 1
\endif

select (hq_private.publish_stock_research('{"schema_version":1,"run_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","researched_at":"2026-11-07T18:00:00Z","outcome":"publish","findings":[{"finding_key":"n1","category":"company_news","horizon":"short","risk":"high","symbol":"NVDA","title":"Chip note","summary":"Sourced note","sources":[{"label":"Wire","url":"https://news.example/n","published_at":"2026-11-07T17:00:00Z"}]}]}'::jsonb)->>'ok')::boolean as published \gset
\if :published
\else
\echo FAIL publish
\quit 1
\endif

-- replay
select (hq_private.publish_stock_research('{"schema_version":1,"run_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","researched_at":"2026-11-07T18:00:00Z","outcome":"publish","findings":[{"finding_key":"n1","category":"company_news","horizon":"short","risk":"high","symbol":"NVDA","title":"Chip note","summary":"Sourced note","sources":[{"label":"Wire","url":"https://news.example/n","published_at":"2026-11-07T17:00:00Z"}]}]}'::jsonb)->>'replay')::boolean as replayed \gset
\if :replayed
\else
\echo FAIL replay
\quit 1
\endif

select count(*) = 1 as one_finding from public.research_findings \gset
\if :one_finding
\else
\echo FAIL duplicate finding
\quit 1
\endif

-- conflicting replay does not replace
select (hq_private.publish_stock_research('{"schema_version":1,"run_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","researched_at":"2026-11-07T18:05:00Z","outcome":"publish","findings":[{"finding_key":"n2","category":"company_news","horizon":"long","risk":"baseline","symbol":"NVDA","title":"Other","summary":"Other","sources":[{"label":"Wire","url":"https://news.example/o","published_at":"2026-11-07T17:00:00Z"}]}]}'::jsonb)->>'error_code') = 'replay_conflict' as conflict \gset
\if :conflict
\else
\echo FAIL conflict
\quit 1
\endif

-- older run preserves last good
select (hq_private.publish_stock_research('{"schema_version":1,"run_id":"cccccccc-cccc-cccc-cccc-cccccccccccc","researched_at":"2026-11-07T17:00:00Z","outcome":"no_change"}'::jsonb)->>'error_code') = 'stale_run' as stale \gset
\if :stale
\else
\echo FAIL stale
\quit 1
\endif
select count(*) = 1 as still_one from public.research_findings \gset
\if :still_one
\else
\echo FAIL last good lost
\quit 1
\endif

-- bad url does not clear notes
select (hq_private.publish_stock_research('{"schema_version":1,"run_id":"dddddddd-dddd-dddd-dddd-dddddddddddd","researched_at":"2026-11-07T19:00:00Z","outcome":"publish","findings":[{"finding_key":"bad","category":"world_events","horizon":"trend","risk":"baseline","title":"X","summary":"Y","sources":[{"label":"js","url":"javascript:alert(1)","published_at":"2026-11-07T18:00:00Z"}]}]}'::jsonb)->>'error_code') = 'bad_url' as badurl \gset
\if :badurl
\else
\echo FAIL url
\quit 1
\endif
select count(*) = 1 as still_one_after_bad from public.research_findings \gset
\if :still_one_after_bad
\else
\echo FAIL wiped
\quit 1
\endif

-- owner isolation
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select count(*) = 0 as other_sees_nothing from public.research_findings \gset
\if :other_sees_nothing
\else
\echo FAIL isolation
\quit 1
\endif
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select count(*) = 1 as owner_sees_note from public.research_findings \gset
\if :owner_sees_note
\else
\echo FAIL owner read
\quit 1
\endif

-- browser write denied
\set ON_ERROR_STOP on
do $$
begin
  insert into public.watchlist (owner_id, bucket, symbol) values ('11111111-1111-1111-1111-111111111111', 'holding', 'NVDA');
  raise exception 'insert should have failed';
exception when insufficient_privilege then
  null;
end $$;

set role anon;
do $$
begin
  perform 1 from public.research_findings;
  raise exception 'anon should have failed';
exception when insufficient_privilege then
  null;
end $$;

\echo SQL_SECURITY_OK
