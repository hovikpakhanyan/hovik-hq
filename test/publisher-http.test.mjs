import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import publisher from '../netlify/functions/publisher.mjs';

const secret = 'super-secret-value';
process.env.HQ_RESOURCE_URL = 'https://hq.hovikp.com';
process.env.HQ_OAUTH_CLIENT_ID = 'hq-client';
process.env.HQ_OWNER_BOOTSTRAP_CODE = 'owner-bootstrap-secret';
process.env.HQ_OAUTH_REDIRECT_URIS = 'https://connector.example/callback';
process.env.HQ_PUBLISHER_DATABASE_URL = `postgresql://hq_publisher.zjsvrfudkigjvvhlehdh:${secret}@127.0.0.1:1/postgres?sslmode=require`;

const challenge = createHash('sha256').update('verifier-value').digest('base64url');

function authorizeUrl(extra = '') {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'hq-client',
    redirect_uri: 'https://connector.example/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'research.publish',
    state: '<script>'
  });
  return 'https://hq.hovikp.com/oauth/authorize?' + params.toString() + extra;
}

test('browser authorize GET returns a consent form and keeps the owner code out of the URL', async () => {
  const res = await publisher(new Request(authorizeUrl()));
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(html.includes('owner-bootstrap-secret'), false);
  assert.equal(html.includes(secret), false);
  assert.equal(html.includes('action="/oauth/authorize"'), true);
  assert.equal(html.includes('action="/oauth/authorize?'), false);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('https://connector.example/callback'), true);
});

test('a bootstrap secret in the authorize query is rejected and not reflected', async () => {
  const res = await publisher(new Request(authorizeUrl('&bootstrap=owner-bootstrap-secret')));
  const text = await res.text();
  assert.equal(res.status, 400);
  assert.equal(text.includes('owner-bootstrap-secret'), false);
  assert.match(text, /bootstrap_in_query/);
});

test('an oversized token body is 413 and the reader is not turned into a database call', async () => {
  const res = await publisher(new Request('https://hq.hovikp.com/oauth/token', {
    method: 'POST',
    body: 'x'.repeat(300000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  }));
  const text = await res.text();
  assert.equal(res.status, 413);
  assert.match(text, /"error":"oversize"/);
  assert.equal(text.includes(secret), false);
});

test('mcp without a bearer advertises protected-resource metadata', async () => {
  const res = await publisher(new Request('https://hq.hovikp.com/mcp', {
    method: 'POST',
    body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    headers: { 'content-type': 'application/json' }
  }));
  const header = res.headers.get('www-authenticate');
  assert.equal(res.status, 401);
  assert.match(header, /resource_metadata="https:\/\/hq\.hovikp\.com\/\.well-known\/oauth-protected-resource"/);
  assert.match(header, /scope="research\.publish research\.status\.read"/);
});

test('a database failure is a generic unavailable response', async () => {
  const res = await publisher(new Request('https://hq.hovikp.com/oauth/token', {
    method: 'POST',
    body: 'grant_type=refresh_token&client_id=hq-client&refresh_token=nope',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  }));
  const text = await res.text();
  assert.equal(res.status, 503);
  assert.match(text, /"error":"unavailable"/);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes('ECONNREFUSED'), false);
  assert.equal(text.includes('127.0.0.1'), false);
});

test('the service-role database url is refused before a connection', async () => {
  const previous = process.env.HQ_PUBLISHER_DATABASE_URL;
  process.env.HQ_PUBLISHER_DATABASE_URL = `postgresql://service_role.zjsvrfudkigjvvhlehdh:${secret}@127.0.0.1:1/postgres?sslmode=require`;
  const res = await publisher(new Request('https://hq.hovikp.com/.well-known/oauth-protected-resource'));
  const text = await res.text();
  process.env.HQ_PUBLISHER_DATABASE_URL = previous;
  assert.equal(res.status, 503);
  assert.match(text, /publisher_role_required/);
  assert.equal(text.includes(secret), false);
});
