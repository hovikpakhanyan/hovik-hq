import { createServer } from 'node:http';
import { createIssuer } from './oauth.mjs';
import { handleMcp } from './mcp.mjs';
import { authorizeTransport, readBody } from './body.mjs';

const required = ['HQ_RESOURCE_URL', 'HQ_OAUTH_CLIENT_ID', 'HQ_OWNER_BOOTSTRAP_CODE', 'HQ_OAUTH_REDIRECT_URIS', 'HQ_PUBLISHER_DATABASE_URL'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error('Publisher refused to start. Missing ' + missing.join(', ') + '. No unauthenticated listener was opened.');
  process.exit(1);
}

const resource = process.env.HQ_RESOURCE_URL.replace(/\/$/, '');
const issuer = createIssuer({
  clientId: process.env.HQ_OAUTH_CLIENT_ID,
  redirectUris: process.env.HQ_OAUTH_REDIRECT_URIS.split(',').map((s) => s.trim()).filter(Boolean),
  bootstrapCode: process.env.HQ_OWNER_BOOTSTRAP_CODE,
  resource
});

async function dbCall(fn, arg) {
  const pg = await import('pg');
  const client = new pg.default.Client({ connectionString: process.env.HQ_PUBLISHER_DATABASE_URL });
  await client.connect();
  try {
    const q = fn === 'publish'
      ? 'select hq_private.publish_stock_research($1::jsonb) as result'
      : 'select hq_private.research_status($1::uuid) as result';
    const { rows } = await client.query(q, [arg]);
    return rows[0].result;
  } finally {
    await client.end();
  }
}

async function takeBody(req, res) {
  try { return await readBody(req); }
  catch (err) {
    if (!res.headersSent) {
      res.writeHead(err.status || 400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: err.status === 413 ? 'oversize' : 'bad_body' }));
    }
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, resource);
  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(issuer.protectedResource()));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(issuer.metadata()));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/oauth/token') {
    const raw = await takeBody(req, res);
    if (raw == null) return;
    const params = new URLSearchParams(raw);
    const result = issuer.token(Object.fromEntries(params));
    res.writeHead(result.error ? result.status : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(result));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/oauth/revoke') {
    const raw = await takeBody(req, res);
    if (raw == null) return;
    const params = new URLSearchParams(raw);
    issuer.revoke(params.get('token') || '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  if (url.pathname === '/oauth/authorize') {
    const blocked = authorizeTransport(req.method, url.searchParams.has('bootstrap'));
    if (blocked) {
      res.writeHead(blocked.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: blocked.error }));
      return;
    }
  }
  if (req.method === 'POST' && url.pathname === '/oauth/authorize') {
    const raw = await takeBody(req, res);
    if (raw == null) return;
    const params = new URLSearchParams(raw);
    const result = issuer.authorize({
      client_id: params.get('client_id'),
      redirect_uri: params.get('redirect_uri'),
      code_challenge: params.get('code_challenge'),
      code_challenge_method: params.get('code_challenge_method'),
      scope: params.get('scope'),
      state: params.get('state'),
      bootstrap: params.get('bootstrap')
    });
    if (result.redirect) {
      res.writeHead(302, { location: result.redirect });
      res.end();
      return;
    }
    res.writeHead(result.status || 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: result.error }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/mcp') {
    const raw = await takeBody(req, res);
    if (raw == null) return;
    const out = await handleMcp({
      auth: issuer,
      db: { publish: (p) => dbCall('publish', p), status: (id) => dbCall('status', id) },
      body: raw,
      authorization: req.headers.authorization
    });
    res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers || {}) });
    res.end(JSON.stringify(out.body));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

const port = Number(process.env.PORT || 8787);
server.listen(port, '127.0.0.1', () => {
  console.log('HQ research publisher listening on 127.0.0.1:' + port + ' for ' + resource);
});
