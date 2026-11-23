import test from 'node:test';
import assert from 'node:assert/strict';
import { createIssuer, createMemoryStore } from '../publisher/oauth.mjs';
import { handleMcp } from '../publisher/mcp.mjs';
import { generateKey, hashKey, looksLikeKey, CLIENT_SCOPES } from '../publisher/keys.mjs';

function setup(limits) {
  const store = createMemoryStore();
  const issuer = createIssuer({
    clientId: 'hq-client', redirectUris: ['https://connector.example/callback'],
    bootstrapCode: 'owner-bootstrap', resource: 'https://hq.example', store, limits
  });
  return { store, issuer };
}

const never = (what) => () => { throw new Error('should not call ' + what); };
const db = {
  publish: () => ({ ok: true, replay: false }),
  status: () => ({ ok: true, configured: true }),
  readResearch: (q) => ({ ok: true, count: 0, notes: [], q }),
  publishDeal: never('publishDeal'),
  dealStatus: never('dealStatus')
};

function call(issuer, key, name, args = {}) {
  return handleMcp({
    auth: issuer, db,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    authorization: 'Bearer ' + key
  });
}

test('key format and hash form', () => {
  const key = generateKey();
  assert.equal(looksLikeKey(key), true);
  assert.equal(key.startsWith('hqpk_'), true);
  assert.match(hashKey(key), /^[0-9a-f]{64}$/);
  assert.equal(looksLikeKey('hqpk_short'), false);
  assert.equal(looksLikeKey(key + 'x'), false);
});

test('issued keys store only the hash and carry the fixed client scopes', async () => {
  const { store, issuer } = setup();
  const issued = await issuer.issueKey('grok-bot', 'main');
  assert.equal(issued.ok, true);
  assert.deepEqual(issued.scopes, ['research.publish', 'research.status.read']);
  const row = store._keys.get(hashKey(issued.key));
  assert.ok(row);
  assert.equal(JSON.stringify([...store._keys.entries()]).includes(issued.key), false);
  const days = (row.expires_at - row.created_at) / 86400000;
  assert.equal(Math.round(days), 90);
  const listed = await issuer.listKeys();
  assert.equal(JSON.stringify(listed).includes(hashKey(issued.key)), false);
  assert.equal(JSON.stringify(listed).includes(issued.key), false);
  assert.equal((await issuer.issueKey('admin', '')).error_code, 'unknown_client');
  assert.deepEqual(CLIENT_SCOPES.claude, ['research.status.read', 'research.read']);
});

test('grok-bot key publishes and reads status, but never reaches deal tools', async () => {
  const { issuer } = setup();
  const { key } = await issuer.issueKey('grok-bot');
  const list = await handleMcp({ auth: issuer, db, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authorization: 'Bearer ' + key });
  assert.deepEqual(list.body.result.tools.map((t) => t.name), ['publish_stock_research', 'research_status']);
  assert.equal((await call(issuer, key, 'research_status')).status, 200);
  const bad = await call(issuer, key, 'publish_stock_research', {});
  assert.equal(bad.status, 200);
  assert.equal(bad.body.result.isError, true);
  assert.equal((await call(issuer, key, 'publish_deal', { kind: 'escrow' })).status, 403);
  assert.equal((await call(issuer, key, 'deal_status')).status, 403);
  assert.equal((await call(issuer, key, 'read_stock_research')).status, 403);
});

test('claude and instinct keys are read-only', async () => {
  const { issuer } = setup();
  for (const client of ['claude', 'instinct']) {
    const { key } = await issuer.issueKey(client);
    const list = await handleMcp({ auth: issuer, db, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authorization: 'Bearer ' + key });
    assert.deepEqual(list.body.result.tools.map((t) => t.name), ['research_status', 'read_stock_research']);
    assert.equal((await call(issuer, key, 'publish_stock_research', {})).status, 403);
    assert.equal((await call(issuer, key, 'publish_deal', {})).status, 403);
    assert.equal((await call(issuer, key, 'deal_status')).status, 403);
    const read = await call(issuer, key, 'read_stock_research', { limit: 500, symbol: 'NVDA' });
    assert.equal(read.status, 200);
    assert.deepEqual(JSON.parse(read.body.result.content[0].text).q, { limit: 50, symbol: 'NVDA', runId: null });
    const forbidden = await call(issuer, key, 'read_stock_research', { owner_id: 'x' });
    assert.match(forbidden.body.result.content[0].text, /forbidden_field/);
  }
});

test('revoked, expired, and unknown keys get the same 401 challenge', async () => {
  const { store, issuer } = setup();
  const a = await issuer.issueKey('grok-bot');
  const b = await issuer.issueKey('claude');
  assert.equal(await issuer.revokeKey(a.id), true);
  store._keys.get(hashKey(b.key)).expires_at = Date.now() - 1;
  for (const key of [a.key, b.key, generateKey(), 'hqpk_nope']) {
    const res = await call(issuer, key, 'research_status');
    assert.equal(res.status, 401);
    assert.match(res.headers['www-authenticate'], /error="invalid_token", resource_metadata="https:\/\/hq\.example\/\.well-known\/oauth-protected-resource"/);
  }
});

test('failed key attempts are rate limited in the shared store', async () => {
  const { issuer } = setup({ keyFail: 2 });
  assert.equal((await call(issuer, generateKey(), 'research_status')).status, 401);
  assert.equal((await call(issuer, generateKey(), 'research_status')).status, 401);
  assert.equal((await call(issuer, generateKey(), 'research_status')).status, 429);
});

test('oauth tokens keep working and do not see the key-only read tool', async () => {
  const { issuer } = setup();
  const { createHash } = await import('node:crypto');
  const challenge = createHash('sha256').update('verifier-value').digest('base64url');
  const granted = await issuer.authorize({
    client_id: 'hq-client', redirect_uri: 'https://connector.example/callback', code_challenge: challenge,
    code_challenge_method: 'S256', scope: 'research.publish research.status.read', bootstrap: 'owner-bootstrap'
  });
  const issued = await issuer.token({
    grant_type: 'authorization_code', client_id: 'hq-client', redirect_uri: 'https://connector.example/callback',
    code_verifier: 'verifier-value', code: new URL(granted.redirect).searchParams.get('code')
  });
  const list = await handleMcp({ auth: issuer, db, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authorization: 'Bearer ' + issued.access_token });
  assert.deepEqual(list.body.result.tools.map((t) => t.name), ['publish_stock_research', 'research_status', 'publish_deal', 'deal_status']);
  assert.equal((await call(issuer, issued.access_token, 'research_status')).status, 200);
  assert.equal((await call(issuer, issued.access_token, 'read_stock_research')).status, 403);
});

test('owner gate is exact and rate limited', async () => {
  const { issuer } = setup({ keys: 2 });
  assert.equal((await issuer.ownerGate('owner-bootstrap ')).status, 401);
  assert.equal((await issuer.ownerGate('owner-bootstrap')).ok, true);
  assert.equal((await issuer.ownerGate('owner-bootstrap')).status, 429);
});
