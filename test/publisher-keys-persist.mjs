// Run against a scratch database with every migration applied, including
// 20261111223000_deal_publisher.sql and 20261123180000_hq_domain_access.sql:
//   HQ_TEST_DATABASE_URL=postgresql://... HQ_TEST_PUBLISHER_URL=postgresql://hq_publisher:... node test/publisher-keys-persist.mjs
import assert from 'node:assert/strict';
import pg from 'pg';
import { createIssuer } from '../publisher/oauth.mjs';
import { createPgStore } from '../publisher/pg-store.mjs';
import { handleMcp } from '../publisher/mcp.mjs';
import { hashKey } from '../publisher/keys.mjs';

const connectionString = process.env.HQ_TEST_DATABASE_URL;
if (!connectionString) throw new Error('HQ_TEST_DATABASE_URL is required');

// HQ_TEST_PUBLISHER_URL connects as hq_publisher itself so grants are exercised.
const store = createPgStore(process.env.HQ_TEST_PUBLISHER_URL || connectionString, { allowLocal: true });
const admin = new pg.Client({ connectionString });
await admin.connect();
const issuer = createIssuer({
  clientId: 'hq-client', redirectUris: ['https://connector.example/callback'],
  bootstrapCode: 'owner-bootstrap', resource: 'https://hq.example', store
});

const grok = await issuer.issueKey('grok-bot', 'main');
assert.equal(grok.ok, true);
assert.equal(grok.scopes.includes('research.publish'), true);
assert.equal(grok.scopes.includes('listings.write'), true);
assert.equal(grok.scopes.includes('tasks.write'), true);
assert.equal(grok.scopes.includes('plan.write'), true);
assert.equal(grok.scopes.length, 17);
const claude = await issuer.issueKey('claude', '');
assert.deepEqual(claude.scopes, grok.scopes);
assert.equal((await issuer.issueKey('escrow-bot', '')).error_code, 'unknown_client');

const stored = await admin.query('select key_hash, scopes, expires_at - created_at as life from hq_private.publisher_keys where id = $1', [grok.id]);
assert.equal(stored.rows[0].key_hash, hashKey(grok.key), 'only the sha256 hex is stored');
assert.equal(stored.rows[0].life.days, 90);
const dump = await admin.query('select row_to_json(k)::text as j from hq_private.publisher_keys k');
assert.equal(dump.rows.some((r) => r.j.includes(grok.key)), false, 'plaintext never stored');

const session = await issuer.introspectKey(grok.key);
assert.equal(session.scope.includes('escrow.write'), true);
assert.equal(session.keyId, grok.id);
assert.equal(session.client, 'grok-bot');
const used = await admin.query('select last_used_at from hq_private.publisher_keys where id = $1', [grok.id]);
assert.ok(used.rows[0].last_used_at, 'last_used_at is stamped');

const listed = await issuer.listKeys();
assert.equal(listed.length, 2);
assert.equal(JSON.stringify(listed).includes(hashKey(grok.key)), false, 'list never returns hashes');

await assert.rejects(admin.query(`insert into hq_private.publisher_keys (client, key_hash, scopes) values ('instinct', $1, array['research.publish'])`, ['a'.repeat(64)]), /publisher_keys_client_scopes/);
await assert.rejects(admin.query(`insert into hq_private.publisher_keys (client, key_hash, scopes) values ('claude', $1, array['deal.publish'])`, ['d'.repeat(64)]), /publisher_keys_(scopes_known|client_scopes)/);
await assert.rejects(admin.query(`insert into hq_private.publisher_keys (client, key_hash, scopes) values ('grok-bot', $1, array['deal.publish'])`, ['b'.repeat(64)]), /publisher_keys_(scopes_known|client_scopes)/);
await assert.rejects(admin.query(`insert into hq_private.publisher_keys (client, key_hash, scopes) values ('escrow', $1, array['research.read'])`, ['c'.repeat(64)]), /check/);
await assert.rejects(admin.query(`insert into hq_private.publisher_keys (client, key_hash, scopes) values ('instinct', $1, array['tasks.write'])`, ['e'.repeat(64)]), /publisher_keys_client_scopes/);
await admin.query(`insert into hq_private.publisher_keys (client, key_hash, scopes) values ('grok-bot', $1, array['listings.read','listings.write'])`, ['f'.repeat(64)]);
await admin.query(`delete from hq_private.publisher_keys where key_hash = $1`, ['f'.repeat(64)]);

await admin.query(`update hq_private.publisher_keys set expires_at = now() - interval '1 second', created_at = now() - interval '2 days' where id = $1`, [claude.id]);
assert.equal(await issuer.introspectKey(claude.key), null, 'expired key is refused');
assert.equal(await issuer.revokeKey(grok.id), true);
assert.equal(await issuer.revokeKey(grok.id), false);
assert.equal(await issuer.introspectKey(grok.key), null, 'revoked key is refused');

const instinct = await issuer.issueKey('instinct', '1');
assert.deepEqual(instinct.scopes, ['research.status.read', 'research.read']);
await issuer.issueKey('instinct', '2');
await issuer.issueKey('instinct', '3');
assert.equal((await issuer.issueKey('instinct', '4')).error_code, 'too_many_active_keys');

// Read tool through the real database function.
await admin.query(`insert into hq_private.owner_config (singleton, owner_id, project_ref) values (1, '11111111-1111-1111-1111-111111111111', 'zjsvrfudkigjvvhlehdh') on conflict do nothing`);
await admin.query(`insert into public.ingestion_runs (run_id, owner_id, schema_version, researched_at, outcome, payload_hash) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 1, now(), 'publish', 'h1'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 1, now(), 'publish', 'h2')`);
await admin.query(`insert into public.research_findings (owner_id, run_id, finding_key, category, horizon, symbol, title, summary, risk, source_published_at, sources, researched_at) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'n1', 'company_news', 'short', 'NVDA', 'Mine', 'Owner note', 'baseline', now(), '[]', now()),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'n2', 'company_news', 'short', 'NVDA', 'Other', 'Not owner', 'baseline', now(), '[]', now())`);
const reader = await issuer.issueKey('claude', 'reader');
const db = {
  readResearch: ({ limit, symbol, runId }) => store.query('select hq_private.read_stock_research($1::int, $2::text, $3::uuid) as result', [limit, symbol, runId]).then((r) => r.rows[0].result)
};
const read = await handleMcp({ auth: issuer, db, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_stock_research', arguments: { symbol: 'NVDA' } } }, authorization: 'Bearer ' + reader.key });
const notes = JSON.parse(read.body.result.content[0].text);
assert.equal(notes.ok, true);
assert.deepEqual(notes.notes.map((n) => n.title), ['Mine'], 'only the bound owner\'s notes');
assert.equal(JSON.stringify(notes).includes('owner_id'), false);

const stamp = new Date(Date.now() - 60 * 1000).toISOString();
const task = await store.query(
  `select hq_private.task_mutate('create', $1::jsonb, 'claude', $2::uuid) as result`,
  [JSON.stringify({ subject: 'Call back', note: 'From the key', priority: 'Low', completed: false }), reader.id]
);
assert.equal(task.rows[0].result.ok, true);
const listing = await store.query(
  `select hq_private.deal_mutate('listing', 'create', $1::jsonb, 'claude', $2::uuid) as result`,
  [JSON.stringify({ external_key: 'L1', title: 'House', status_label: 'Active', lane: 'current', updated_at: stamp }), reader.id]
);
assert.equal(listing.rows[0].result.ok, true);
const archived = await store.query(
  `select hq_private.deal_mutate('listing', 'update', '{"external_key":"L1","archive":true}'::jsonb, 'claude', $1::uuid) as result`,
  [reader.id]
);
assert.equal(archived.rows[0].result.archived, true);
const kept = await admin.query(`select count(*)::int as n, count(archived_at)::int as archived from public.deal_records`);
assert.equal(kept.rows[0].n, 1);
assert.equal(kept.rows[0].archived, 1);
const published = await store.query(
  `select hq_private.publish_deal_audited($1::jsonb, 'oauth', null) as result`,
  [JSON.stringify({ schema_version: 1, record_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', external_key: 'P1', kind: 'pipeline', lane: 'pipeline', title: 'Pipe', status_label: 'Pipeline', updated_at: stamp })]
);
assert.equal(published.rows[0].result.ok, true);
const denied = await store.query(
  `select hq_private.task_mutate('create', '{"subject":"no"}'::jsonb, 'instinct', $1::uuid) as result`,
  [instinct.id]
);
assert.equal(denied.rows[0].result.ok, false);
const dealDenied = await store.query(
  `select hq_private.publish_deal_audited($1::jsonb, 'instinct', $2::uuid) as result`,
  [JSON.stringify({ schema_version: 1, record_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', external_key: 'E1', kind: 'escrow', lane: 'escrow', title: 'E', status_label: 'Open', updated_at: stamp }), instinct.id]
);
assert.equal(dealDenied.rows[0].result.error_code, 'insufficient_scope');
const audited = await admin.query(`select client, key_id::text, tool from hq_private.mcp_audit order by id`);
assert.deepEqual(audited.rows.map((row) => row.tool), ['create_task', 'create_listing', 'update_listing', 'publish_deal']);
assert.equal(audited.rows.slice(0, 3).every((row) => row.client === 'claude' && row.key_id === reader.id), true);
assert.equal(audited.rows[3].client, 'oauth');
assert.equal(audited.rows[3].key_id, null);
await assert.rejects(store.query('select * from public.hq_tasks'), /permission denied/);
await assert.rejects(store.query('delete from public.deal_records'), /permission denied/);

const privileges = await admin.query(`
  select
    has_table_privilege('hq_publisher', 'hq_private.publisher_keys', 'select') as p_select,
    has_table_privilege('hq_publisher', 'hq_private.publisher_keys', 'insert') as p_insert,
    has_table_privilege('hq_publisher', 'hq_private.publisher_keys', 'update') as p_update,
    has_table_privilege('hq_publisher', 'hq_private.publisher_keys', 'delete') as p_delete,
    has_function_privilege('hq_publisher', 'hq_private.publisher_key_check(text)', 'execute') as p_check,
    has_function_privilege('hq_publisher', 'hq_private.read_stock_research(integer, text, uuid)', 'execute') as p_read,
    has_function_privilege('authenticated', 'hq_private.publisher_key_issue(text, text, text)', 'execute') as auth_issue,
    has_function_privilege('anon', 'hq_private.publisher_key_check(text)', 'execute') as anon_check,
    has_table_privilege('hq_publisher', 'public.hq_tasks', 'insert') as task_insert,
    has_table_privilege('hq_publisher', 'hq_private.mcp_audit', 'insert') as audit_insert,
    has_table_privilege('authenticated', 'public.hq_tasks', 'insert') as owner_task,
    has_table_privilege('authenticated', 'public.hq_tasks', 'delete') as owner_task_delete,
    has_table_privilege('authenticated', 'public.hq_plan', 'delete') as owner_plan_delete,
    has_table_privilege('anon', 'public.hq_notes', 'select') as anon_notes,
    has_function_privilege('hq_publisher', 'hq_private.task_mutate(text, jsonb, text, uuid)', 'execute') as task_fn,
    has_function_privilege('authenticated', 'hq_private.deal_mutate(text, text, jsonb, text, uuid)', 'execute') as auth_deal
`);
assert.deepEqual(privileges.rows[0], {
  p_select: false, p_insert: false, p_update: false, p_delete: false, p_check: true, p_read: true, auth_issue: false, anon_check: false,
  task_insert: false, audit_insert: false, owner_task: true, owner_task_delete: true, owner_plan_delete: false, anon_notes: false,
  task_fn: true, auth_deal: false
});

await admin.end();
await store.end();
console.log('PUBLISHER_KEYS_PERSIST_OK');
