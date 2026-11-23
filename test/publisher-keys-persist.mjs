// Run against a scratch database with the research, oauth token, oauth guard,
// publisher key, and claude publish-scope migrations applied (not the deal migration):
//   HQ_TEST_DATABASE_URL=postgresql://... node test/publisher-keys-persist.mjs
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
assert.deepEqual(grok.scopes, ['research.publish', 'research.status.read']);
const claude = await issuer.issueKey('claude', '');
assert.deepEqual(claude.scopes, ['research.publish', 'research.status.read', 'research.read']);
assert.equal((await issuer.issueKey('escrow-bot', '')).error_code, 'unknown_client');

const stored = await admin.query('select key_hash, scopes, expires_at - created_at as life from hq_private.publisher_keys where id = $1', [grok.id]);
assert.equal(stored.rows[0].key_hash, hashKey(grok.key), 'only the sha256 hex is stored');
assert.equal(stored.rows[0].life.days, 90);
const dump = await admin.query('select row_to_json(k)::text as j from hq_private.publisher_keys k');
assert.equal(dump.rows.some((r) => r.j.includes(grok.key)), false, 'plaintext never stored');

const session = await issuer.introspectKey(grok.key);
assert.deepEqual(session.scope, ['research.publish', 'research.status.read']);
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

await admin.query(`update hq_private.publisher_keys set expires_at = now() - interval '1 second', created_at = now() - interval '2 days' where id = $1`, [claude.id]);
assert.equal(await issuer.introspectKey(claude.key), null, 'expired key is refused');
assert.equal(await issuer.revokeKey(grok.id), true);
assert.equal(await issuer.revokeKey(grok.id), false);
assert.equal(await issuer.introspectKey(grok.key), null, 'revoked key is refused');

await issuer.issueKey('instinct', '1');
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

const privileges = await admin.query(`
  select
    has_table_privilege('hq_publisher', 'hq_private.publisher_keys', 'select') as p_select,
    has_table_privilege('hq_publisher', 'hq_private.publisher_keys', 'insert') as p_insert,
    has_table_privilege('hq_publisher', 'hq_private.publisher_keys', 'update') as p_update,
    has_table_privilege('hq_publisher', 'hq_private.publisher_keys', 'delete') as p_delete,
    has_function_privilege('hq_publisher', 'hq_private.publisher_key_check(text)', 'execute') as p_check,
    has_function_privilege('hq_publisher', 'hq_private.read_stock_research(integer, text, uuid)', 'execute') as p_read,
    has_function_privilege('authenticated', 'hq_private.publisher_key_issue(text, text, text)', 'execute') as auth_issue,
    has_function_privilege('anon', 'hq_private.publisher_key_check(text)', 'execute') as anon_check
`);
assert.deepEqual(privileges.rows[0], { p_select: false, p_insert: false, p_update: false, p_delete: false, p_check: true, p_read: true, auth_issue: false, anon_check: false });

await admin.end();
await store.end();
console.log('PUBLISHER_KEYS_PERSIST_OK');
