import { createIssuer } from '../../publisher/oauth.mjs';
import { handleMcp } from '../../publisher/mcp.mjs';
import { authorizeTransport, readWebBody } from '../../publisher/body.mjs';
import { createPgStore } from '../../publisher/pg-store.mjs';
import pg from 'pg';

const REQUIRED = ['HQ_RESOURCE_URL', 'HQ_OAUTH_CLIENT_ID', 'HQ_OWNER_BOOTSTRAP_CODE', 'HQ_OAUTH_REDIRECT_URIS', 'HQ_PUBLISHER_DATABASE_URL'];

function missingEnv() {
  return REQUIRED.filter((key) => !process.env[key]);
}

let store;
function getStore() {
  if (!store) store = createPgStore(process.env.HQ_PUBLISHER_DATABASE_URL);
  return store;
}

function getIssuer() {
  const resource = process.env.HQ_RESOURCE_URL.replace(/\/$/, '');
  return createIssuer({
    clientId: process.env.HQ_OAUTH_CLIENT_ID,
    redirectUris: process.env.HQ_OAUTH_REDIRECT_URIS.split(',').map((s) => s.trim()).filter(Boolean),
    bootstrapCode: process.env.HQ_OWNER_BOOTSTRAP_CODE,
    resource,
    store: getStore()
  });
}

async function dbCall(fn, arg) {
  const client = new pg.Client({ connectionString: process.env.HQ_PUBLISHER_DATABASE_URL });
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

export default async function publisher(req) {
  const missing = missingEnv();
  if (missing.length) {
    return Response.json({ error: 'unconfigured' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  const url = new URL(req.url);
  const issuer = getIssuer();
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    return Response.json(issuer.protectedResource());
  }
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    return Response.json(issuer.metadata());
  }
  if (url.pathname === '/oauth/authorize') {
    const blocked = authorizeTransport(req.method, url.searchParams.has('bootstrap'));
    if (blocked) return Response.json({ error: blocked.error }, { status: blocked.status, headers: { 'cache-control': 'no-store' } });
    const raw = await readWebBody(req);
    const params = new URLSearchParams(raw);
    const result = await issuer.authorize({
      client_id: params.get('client_id'),
      redirect_uri: params.get('redirect_uri'),
      code_challenge: params.get('code_challenge'),
      code_challenge_method: params.get('code_challenge_method'),
      scope: params.get('scope'),
      state: params.get('state'),
      bootstrap: params.get('bootstrap')
    });
    if (result.redirect) return Response.redirect(result.redirect, 302);
    return Response.json({ error: result.error }, { status: result.status || 400, headers: { 'cache-control': 'no-store' } });
  }
  if (req.method === 'POST' && url.pathname === '/oauth/token') {
    const params = new URLSearchParams(await readWebBody(req));
    const result = await issuer.token(Object.fromEntries(params));
    return Response.json(result, { status: result.error ? result.status : 200, headers: { 'cache-control': 'no-store' } });
  }
  if (req.method === 'POST' && url.pathname === '/oauth/revoke') {
    const params = new URLSearchParams(await readWebBody(req));
    await issuer.revoke(params.get('token') || '');
    return Response.json({}, { headers: { 'cache-control': 'no-store' } });
  }
  if (req.method === 'POST' && url.pathname === '/mcp') {
    const out = await handleMcp({
      auth: issuer,
      db: { publish: (payload) => dbCall('publish', payload), status: (id) => dbCall('status', id) },
      body: await readWebBody(req),
      authorization: req.headers.get('authorization') || ''
    });
    return Response.json(out.body, { status: out.status, headers: { 'cache-control': 'no-store', ...(out.headers || {}) } });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}

export const config = {
  path: [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/oauth/*',
    '/mcp'
  ]
};
