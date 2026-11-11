import { createIssuer } from '../../publisher/oauth.mjs';
import { handleMcp } from '../../publisher/mcp.mjs';
import { authorizeTransport, readWebBody } from '../../publisher/body.mjs';
import { createPgStore } from '../../publisher/pg-store.mjs';
import { publisherDbConfig } from '../../publisher/db-config.mjs';

const REQUIRED = ['HQ_RESOURCE_URL', 'HQ_OAUTH_CLIENT_ID', 'HQ_OWNER_BOOTSTRAP_CODE', 'HQ_OAUTH_REDIRECT_URIS', 'HQ_PUBLISHER_DATABASE_URL'];

function json(body, status = 200, extra = {}) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...extra } });
}

function configProblem() {
  if (REQUIRED.some((key) => !process.env[key])) return 'unconfigured';
  let origin;
  try { origin = new URL(process.env.HQ_RESOURCE_URL); }
  catch { return 'unconfigured'; }
  if (origin.protocol !== 'https:' || origin.username || origin.password) return 'unconfigured';
  try { publisherDbConfig(process.env.HQ_PUBLISHER_DATABASE_URL); }
  catch (err) { return err.code || 'unconfigured'; }
  return null;
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

function oauthFields(params) {
  return {
    response_type: params.get('response_type') || 'code',
    client_id: params.get('client_id'),
    redirect_uri: params.get('redirect_uri'),
    code_challenge: params.get('code_challenge'),
    code_challenge_method: params.get('code_challenge_method'),
    scope: params.get('scope'),
    state: params.get('state'),
    bootstrap: params.get('bootstrap')
  };
}

async function takeBody(req) {
  try { return { raw: await readWebBody(req) }; }
  catch (err) {
    const status = err.status === 413 ? 413 : 400;
    return { response: json({ error: status === 413 ? 'oversize' : 'bad_body' }, status) };
  }
}

async function route(req) {
  const problem = configProblem();
  if (problem) return json({ error: problem }, 503);
  const url = new URL(req.url);
  const issuer = getIssuer();
  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
    return json(issuer.protectedResource());
  }
  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
    return json(issuer.metadata());
  }
  if (url.pathname === '/oauth/authorize') {
    const blocked = authorizeTransport(req.method, url.searchParams.has('bootstrap'));
    if (blocked) return json({ error: blocked.error }, blocked.status);
    if (req.method === 'GET') {
      const view = issuer.consent(oauthFields(url.searchParams));
      if (view.error) return json({ error: view.error }, view.status || 400);
      return new Response(view.html, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"
        }
      });
    }
    const taken = await takeBody(req);
    if (taken.response) return taken.response;
    const params = new URLSearchParams(taken.raw);
    const result = await issuer.authorize(oauthFields(params));
    if (result.redirect) {
      return new Response(null, {
        status: 302,
        headers: { location: result.redirect, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
      });
    }
    return json({ error: result.error }, result.status || 400);
  }
  if (req.method === 'POST' && url.pathname === '/oauth/token') {
    const taken = await takeBody(req);
    if (taken.response) return taken.response;
    const result = await issuer.token(Object.fromEntries(new URLSearchParams(taken.raw)));
    return json(result, result.error ? result.status : 200);
  }
  if (req.method === 'POST' && url.pathname === '/oauth/revoke') {
    const taken = await takeBody(req);
    if (taken.response) return taken.response;
    await issuer.revoke(new URLSearchParams(taken.raw).get('token') || '');
    return json({});
  }
  if (req.method === 'POST' && url.pathname === '/mcp') {
    const taken = await takeBody(req);
    if (taken.response) return taken.response;
    const out = await handleMcp({
      auth: issuer,
      db: {
        publish: (payload) => getStore().query('select hq_private.publish_stock_research($1::jsonb) as result', [payload]).then((r) => r.rows[0].result),
        status: (id) => getStore().query('select hq_private.research_status($1::uuid) as result', [id]).then((r) => r.rows[0].result),
        publishDeal: (payload) => getStore().query('select hq_private.publish_deal($1::jsonb) as result', [payload]).then((r) => r.rows[0].result),
        dealStatus: (key) => getStore().query('select hq_private.deal_status($1::text) as result', [key]).then((r) => r.rows[0].result)
      },
      body: taken.raw,
      authorization: req.headers.get('authorization') || ''
    });
    return json(out.body, out.status, out.headers || {});
  }
  return json({ error: 'not_found' }, 404);
}

export default async function publisher(req) {
  try { return await route(req); }
  catch {
    return json({ error: 'unavailable' }, 503);
  }
}

export const config = {
  path: [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/oauth/*',
    '/mcp'
  ]
};
