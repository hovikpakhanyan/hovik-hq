import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createIssuer } from '../publisher/oauth.mjs';
import { createPgStore } from '../publisher/pg-store.mjs';

const connectionString = process.env.HQ_TEST_DATABASE_URL;
if (!connectionString) throw new Error('HQ_TEST_DATABASE_URL is required');

const storeA = createPgStore(connectionString);
const storeB = createPgStore(connectionString);
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
assert.equal(await other.introspect(second.access_token), null);
await storeA.end();
await storeB.end();
console.log('OAUTH_PERSIST_OK');
