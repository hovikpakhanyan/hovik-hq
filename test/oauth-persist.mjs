import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createIssuer } from '../publisher/oauth.mjs';
import { createPgStore } from '../publisher/pg-store.mjs';

const connectionString = process.env.HQ_TEST_DATABASE_URL;
if (!connectionString) throw new Error('HQ_TEST_DATABASE_URL is required');

const storeA = createPgStore(connectionString, { allowLocal: true });
const storeB = createPgStore(connectionString, { allowLocal: true });
const issuer = createIssuer({
  clientId: 'hq-client',
  redirectUris: ['https://connector.example/callback'],
  bootstrapCode: 'owner-bootstrap',
  resource: 'https://hq.example',
  store: storeA
});
const other = createIssuer({
  clientId: 'hq-client',
  redirectUris: ['https://connector.example/callback'],
  bootstrapCode: 'owner-bootstrap',
  resource: 'https://hq.example',
  store: storeB
});

const challenge = createHash('sha256').update('verifier-value').digest('base64url');
const granted = await issuer.authorize({
  client_id: 'hq-client',
  redirect_uri: 'https://connector.example/callback',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: 'research.publish research.status.read',
  bootstrap: 'owner-bootstrap'
});
const code = new URL(granted.redirect).searchParams.get('code');
const first = await issuer.token({
  grant_type: 'authorization_code',
  client_id: 'hq-client',
  code,
  redirect_uri: 'https://connector.example/callback',
  code_verifier: 'verifier-value'
});
const seen = await other.introspect(first.access_token);
assert.ok(seen && seen.active, 'a second connection must see a stored access token');

const client = new pg.Client({ connectionString });
await client.connect();
const { hashToken } = await import('../publisher/oauth.mjs');
const raw = await client.query('select count(*)::int as n from hq_private.oauth_access where token_hash = $1', [first.access_token]);
const hashed = await client.query('select count(*)::int as n from hq_private.oauth_access where token_hash = $1', [hashToken(first.access_token)]);
assert.equal(raw.rows[0].n, 0, 'raw access token must not be stored');
assert.equal(hashed.rows[0].n, 1, 'only the hash is stored');
await client.end();

await storeB.revoke(hashToken(first.refresh_token));
assert.equal(await storeA.introspect(hashToken(first.access_token)), null);

const again = await issuer.authorize({
  client_id: 'hq-client',
  redirect_uri: 'https://connector.example/callback',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: 'research.publish',
  bootstrap: 'owner-bootstrap'
});
const code2 = new URL(again.redirect).searchParams.get('code');
const second = await issuer.token({
  grant_type: 'authorization_code',
  client_id: 'hq-client',
  code: code2,
  redirect_uri: 'https://connector.example/callback',
  code_verifier: 'verifier-value'
});
const oldHash = hashToken(second.refresh_token);
const [one, two] = await Promise.all([
  storeA.rotate({ oldHash, accessHash: 'a'.repeat(64), refreshHash: 'b'.repeat(64), accessExp: Date.now() + 60000, refreshExp: Date.now() + 60000 }),
  storeB.rotate({ oldHash, accessHash: 'c'.repeat(64), refreshHash: 'd'.repeat(64), accessExp: Date.now() + 60000, refreshExp: Date.now() + 60000 })
]);
const oks = [one, two].filter((row) => row.ok).length;
assert.equal(oks, 1, 'only one concurrent refresh may succeed');
assert.equal(await storeA.introspect('a'.repeat(64)), null, 'the raced access token must not survive family revoke');
assert.equal(await storeB.introspect('c'.repeat(64)), null, 'the other raced access token must not survive family revoke');
assert.equal(await other.introspect(second.access_token), null);

const fresh = await issuer.authorize({
  client_id: 'hq-client',
  redirect_uri: 'https://connector.example/callback',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: 'research.publish',
  bootstrap: 'owner-bootstrap'
});
const rollbackToken = await issuer.token({
  grant_type: 'authorization_code',
  client_id: 'hq-client',
  code: new URL(fresh.redirect).searchParams.get('code'),
  redirect_uri: 'https://connector.example/callback',
  code_verifier: 'verifier-value'
});
const rollback = new pg.Client({ connectionString });
await rollback.connect();
await rollback.query('begin');
const rolled = await rollback.query(
  'select hq_private.oauth_rotate($1,$2,$3, now() + interval \'10 minutes\', now() + interval \'14 days\') as result',
  [hashToken(rollbackToken.refresh_token), 'e'.repeat(64), 'f'.repeat(64)]
);
assert.equal(rolled.rows[0].result.ok, true);
await rollback.query('rollback');
await rollback.end();
const afterRollback = await storeB.rotate({
  oldHash: hashToken(rollbackToken.refresh_token),
  accessHash: '1'.repeat(64),
  refreshHash: '2'.repeat(64),
  accessExp: Date.now() + 60000,
  refreshExp: Date.now() + 60000
});
assert.equal(afterRollback.ok, true, 'a rolled-back refresh must leave the original token usable');

await storeA.end();
const restarted = createPgStore(connectionString, { allowLocal: true });
assert.equal(await restarted.introspect(hashToken(first.access_token)), null, 'a new pool after restart must see the revoke');
const admin = new pg.Client({ connectionString });
await admin.connect();
await admin.query(`
  insert into hq_private.oauth_access (token_hash, family_id, scope, expires_at)
  values ('expired-access', $1, 'research.status.read', now() - interval '1 minute')
`, [afterRollback.family]);
await admin.query(`
  insert into hq_private.oauth_refresh (token_hash, family_id, scope, expires_at, consumed_at)
  values ('consumed-live', $1, 'research.status.read', now() + interval '1 day', now())
`, [afterRollback.family]);
await restarted.purge();
const expired = await admin.query(`select count(*)::int as n from hq_private.oauth_access where token_hash = 'expired-access'`);
const consumed = await admin.query(`select count(*)::int as n from hq_private.oauth_refresh where token_hash = 'consumed-live'`);
assert.equal(expired.rows[0].n, 0, 'expired access tokens are removed');
assert.equal(consumed.rows[0].n, 1, 'a consumed refresh token stays until it expires');
const privileges = await admin.query(`
  select
    has_table_privilege('hq_publisher', 'hq_private.oauth_access', 'select') as publisher_select,
    has_table_privilege('hq_publisher', 'hq_private.oauth_access', 'insert') as publisher_insert,
    has_function_privilege('hq_publisher', 'hq_private.oauth_introspect(text)', 'execute') as publisher_execute,
    has_function_privilege('authenticated', 'hq_private.oauth_save_code(text, text, text, text, text, timestamptz)', 'execute') as authenticated_execute,
    has_function_privilege('anon', 'hq_private.oauth_hit(text, integer, integer)', 'execute') as anon_hit
`);
assert.equal(privileges.rows[0].publisher_select, false);
assert.equal(privileges.rows[0].publisher_insert, false);
assert.equal(privileges.rows[0].publisher_execute, true);
assert.equal(privileges.rows[0].authenticated_execute, false);
assert.equal(privileges.rows[0].anon_hit, false);
await admin.end();
await restarted.end();
await storeB.end();
console.log('OAUTH_PERSIST_OK');
