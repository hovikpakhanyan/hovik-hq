import { createIssuer } from '../../publisher/oauth.mjs';
import { handleMcp } from '../../publisher/mcp.mjs';
import { authorizeTransport, readWebBody } from '../../publisher/body.mjs';
import { createPgStore } from '../../publisher/pg-store.mjs';
import { publisherDbConfig } from '../../publisher/db-config.mjs';
import { keysHomePage, keysListPage, keyIssuedPage, keysErrorPage } from '../../publisher/keys-page.mjs';

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

const DOMAIN_SQL = {
  deal_rows: 'select hq_private.deal_rows($1::text, $2::text, $3::int, $4::boolean) as result',
  deal_counts: 'select hq_private.deal_counts($1::text[]) as result',
  deal_mutate: 'select hq_private.deal_mutate($1::text, $2::text, $3::jsonb, $4::text, $5::uuid) as result',
  task_rows: 'select hq_private.task_rows($1::uuid, $2::int, $3::boolean) as result',
  task_mutate: 'select hq_private.task_mutate($1::text, $2::jsonb, $3::text, $4::uuid) as result',
  note_rows: 'select hq_private.note_rows($1::uuid, $2::int) as result',
  note_mutate: 'select hq_private.note_mutate($1::text, $2::jsonb, $3::text, $4::uuid) as result',
  watch_rows: 'select hq_private.watch_rows($1::uuid, $2::text, $3::text, $4::int) as result',
  watch_mutate: 'select hq_private.watch_mutate($1::text, $2::jsonb, $3::text, $4::uuid) as result',
  plan_read: 'select hq_private.plan_read($1::uuid) as result',
  plan_mutate: 'select hq_private.plan_mutate($1::text, $2::jsonb, $3::text, $4::uuid) as result'
};

function domainCall(fn, args) {
  const sql = DOMAIN_SQL[fn];
  if (!sql) return Promise.reject(new Error('unknown domain call'));
  return getStore().query(sql, args).then((r) => r.rows[0].result);
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

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};

function page(html, status = 200) {
  return new Response(html, { status, headers: PAGE_HEADERS });
}

const KEY_ERRORS = {
  rate_limited: 'Too many attempts. Wait ten minutes and try again.',
  access_denied: 'That owner code did not match.',
  unknown_client: 'Pick one of the listed clients.',
  too_many_active_keys: 'This client already has three active keys. Revoke one first.',
  bad_origin: 'This form must be sent from the HQ page itself.',
  server_unconfigured: 'The publisher is not configured.'
};

async function keysRoute(req, url, issuer) {
  const blocked = authorizeTransport(req.method, url.searchParams.has('bootstrap'));
  if (blocked) return json({ error: blocked.error }, blocked.status);
  if (req.method === 'GET') return page(keysHomePage());
  const origin = req.headers.get('origin');
  const expected = new URL(process.env.HQ_RESOURCE_URL).origin;
  if (origin !== null && origin !== expected) return page(keysErrorPage(KEY_ERRORS.bad_origin), 403);
  const taken = await takeBody(req);
  if (taken.response) return taken.response;
  const params = new URLSearchParams(taken.raw);
  const gate = await issuer.ownerGate(params.get('bootstrap') || '');
  if (!gate.ok) return page(keysErrorPage(KEY_ERRORS[gate.error] || 'Not allowed.'), gate.status || 401);
  const action = params.get('action');
  if (action === 'issue') {
    const issued = await issuer.issueKey(params.get('client') || '', params.get('label') || '');
    if (!issued.ok) return page(keysErrorPage(KEY_ERRORS[issued.error_code] || 'The key was not created.'), 400);
    return page(keyIssuedPage(issued, await issuer.listKeys()));
  }
  if (action === 'revoke') {
    const done = await issuer.revokeKey(params.get('id') || '');
    return page(keysListPage(await issuer.listKeys(), done ? 'Key revoked.' : 'That key was already revoked or not found.'));
  }
  if (action === 'list') return page(keysListPage(await issuer.listKeys()));
  return page(keysErrorPage('Unknown action.'), 400);
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
  if (url.pathname === '/publisher/keys') return keysRoute(req, url, issuer);
  if (req.method === 'POST' && url.pathname === '/mcp') {
    const taken = await takeBody(req);
    if (taken.response) return taken.response;
    const out = await handleMcp({
      auth: issuer,
      db: {
        publish: (payload) => getStore().query('select hq_private.publish_stock_research($1::jsonb) as result', [payload]).then((r) => r.rows[0].result),
        status: (id) => getStore().query('select hq_private.research_status($1::uuid) as result', [id]).then((r) => r.rows[0].result),
        publishDeal: (payload, actor) => getStore().query(
          'select hq_private.publish_deal_audited($1::jsonb, $2::text, $3::uuid) as result',
          [payload, actor && actor.client ? actor.client : 'oauth', actor && actor.keyId ? actor.keyId : null]
        ).then((r) => r.rows[0].result),
        readResearch: ({ limit, symbol, runId }) => getStore().query('select hq_private.read_stock_research($1::int, $2::text, $3::uuid) as result', [limit, symbol, runId]).then((r) => r.rows[0].result),
        dealStatus: (key) => getStore().query('select hq_private.deal_status($1::text) as result', [key]).then((r) => r.rows[0].result),
        dealCounts: (kinds) => getStore().query('select hq_private.deal_counts($1::text[]) as result', [kinds]).then((r) => r.rows[0].result),
        domain: ({ fn, args }) => domainCall(fn, args)
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
    '/publisher/keys',
    '/mcp'
  ]
};
