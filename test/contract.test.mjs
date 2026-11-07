import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { authorizeTransport, readBody } from '../publisher/body.mjs';
import { EventEmitter } from 'node:events';
import { forbiddenKey, httpsOk, preflight } from '../publisher/validate.mjs';
import { createIssuer } from '../publisher/oauth.mjs';
import { handleMcp } from '../publisher/mcp.mjs';

const ui = { URL, Date, Number, String };
vm.runInNewContext(fs.readFileSync(new URL('../research-ui.js', import.meta.url), 'utf8'), ui);
const HQResearch = ui.HQResearch;

test('rejects caller owner, sql, and price fields', () => {
  assert.equal(preflight({ schema_version: 1, run_id: '11111111-1111-1111-1111-111111111111', researched_at: '2026-11-07T16:00:00Z', outcome: 'publish', owner_id: 'x' }).error_code, 'forbidden_field');
  assert.equal(forbiddenKey({ findings: [{ price: 12 }] }), 'price');
  assert.equal(httpsOk('javascript:alert(1)'), false);
  assert.equal(httpsOk('https://user:pass@example.com/a'), false);
  assert.equal(httpsOk('https://news.example.com/story'), true);
});

test('oauth code, refresh rotation, and revoked replay', async () => {
  const issuer = createIssuer({
    clientId: 'hq-client',
    redirectUris: ['https://connector.example/callback'],
    bootstrapCode: 'owner-bootstrap',
    resource: 'https://publisher.example'
  });
  const challenge = createHash('sha256').update('verifier-value').digest('base64url');
  const denied = await issuer.authorize({ client_id: 'hq-client', redirect_uri: 'https://connector.example/callback', code_challenge: challenge, code_challenge_method: 'S256', scope: 'research.publish', bootstrap: 'nope' });
  assert.equal(denied.status, 401);
  const ok = await issuer.authorize({ client_id: 'hq-client', redirect_uri: 'https://connector.example/callback', code_challenge: challenge, code_challenge_method: 'S256', scope: 'research.publish research.status.read', state: 's', bootstrap: 'owner-bootstrap' });
  const code = new URL(ok.redirect).searchParams.get('code');
  const first = await issuer.token({ grant_type: 'authorization_code', client_id: 'hq-client', code, redirect_uri: 'https://connector.example/callback', code_verifier: 'verifier-value' });
  assert.ok(first.access_token);
  const rotated = await issuer.token({ grant_type: 'refresh_token', client_id: 'hq-client', refresh_token: first.refresh_token });
  assert.ok(rotated.access_token);
  const replay = await issuer.token({ grant_type: 'refresh_token', client_id: 'hq-client', refresh_token: first.refresh_token });
  assert.equal(replay.error, 'invalid_grant');
  assert.equal(await issuer.introspect(rotated.access_token), null);
});

test('revoke kills the access token in the same family', async () => {
  const issuer = createIssuer({ clientId: 'hq-client', redirectUris: ['https://connector.example/callback'], bootstrapCode: 'owner-bootstrap', resource: 'https://publisher.example' });
  const challenge = createHash('sha256').update('verifier-value').digest('base64url');
  const ok = await issuer.authorize({ client_id: 'hq-client', redirect_uri: 'https://connector.example/callback', code_challenge: challenge, code_challenge_method: 'S256', scope: 'research.publish', bootstrap: 'owner-bootstrap' });
  const code = new URL(ok.redirect).searchParams.get('code');
  const issued = await issuer.token({ grant_type: 'authorization_code', client_id: 'hq-client', code, redirect_uri: 'https://connector.example/callback', code_verifier: 'verifier-value' });
  await issuer.revoke(issued.refresh_token);
  assert.equal(await issuer.introspect(issued.access_token), null);
});

test('bootstrap is not accepted from a query string and bodies are bounded', async () => {
  assert.deepEqual(authorizeTransport('GET', true), { status: 400, error: 'bootstrap_in_query' });
  assert.deepEqual(authorizeTransport('GET', false), { status: 405, error: 'use_post_body' });
  assert.equal(authorizeTransport('POST', false), null);
  const req = new EventEmitter();
  req.destroy = () => {};
  const pending = readBody(req, 8);
  req.emit('data', Buffer.from('123456789'));
  await assert.rejects(pending, (err) => err.status === 413);
});

test('mcp tool call without a token is not a publisher', async () => {
  const issuer = createIssuer({ clientId: 'c', redirectUris: ['https://x/cb'], bootstrapCode: 'b', resource: 'https://p.example' });
  const res = await handleMcp({ auth: issuer, db: { publish() { throw new Error('should not write'); } }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'publish_stock_research', arguments: {} } }, authorization: '' });
  assert.equal(res.status, 401);
});

test('research view escapes text and withholds bad links', () => {
  const html = HQResearch.renderView({
    configured: true,
    holdings: [{ symbol: '<img>' }],
    watch: [],
    candidates: [],
    findings: [{
      category: 'analysis', risk: 'high', horizon: 'short', title: 'Note', summary: 'Text',
      thesis: 'T', contrary: 'C', impacted: ['NVDA'],
      sources: [{ label: 'Bad', url: 'javascript:alert(1)', published_at: '2026-11-07T00:00:00Z' }, { label: 'Wire', url: 'https://news.example/a', published_at: '2026-11-07T00:00:00Z' }]
    }]
  });
  assert.equal(html.includes('<img>'), false);
  assert.equal(html.includes('javascript:'), false);
  assert.equal(html.includes('https://news.example/a'), true);
  assert.equal(html.includes('High risk'), true);
  assert.equal(html.includes('Not configured'), true);
  assert.equal(HQResearch.renderCard({ configured: false }).includes('not set up'), true);
});
