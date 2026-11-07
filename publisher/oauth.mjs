import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function same(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const ALLOWED_SCOPES = ['research.publish', 'research.status.read'];

export function createIssuer(options) {
  const clientId = options.clientId;
  const redirectUris = new Set(options.redirectUris || []);
  const bootstrap = options.bootstrapCode;
  const resource = options.resource;
  const codes = new Map();
  const access = new Map();
  const refresh = new Map();
  const families = new Map();
  const spentRefresh = new Map();

  function metadata() {
    return {
      issuer: resource,
      authorization_endpoint: resource + '/oauth/authorize',
      token_endpoint: resource + '/oauth/token',
      revocation_endpoint: resource + '/oauth/revoke',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ALLOWED_SCOPES,
      token_endpoint_auth_methods_supported: ['none']
    };
  }

  function protectedResource() {
    return {
      resource,
      authorization_servers: [resource],
      scopes_supported: ALLOWED_SCOPES,
      bearer_methods_supported: ['header']
    };
  }

  function authorize(input) {
    if (!bootstrap) return { error: 'server_unconfigured', status: 503 };
    if (input.client_id !== clientId) return { error: 'unauthorized_client', status: 400 };
    if (!redirectUris.has(input.redirect_uri)) return { error: 'invalid_redirect', status: 400 };
    if (input.code_challenge_method !== 'S256' || !input.code_challenge) return { error: 'invalid_request', status: 400 };
    if (!same(input.bootstrap || '', bootstrap)) return { error: 'access_denied', status: 401 };
    const requested = String(input.scope || '').split(/\s+/).filter(Boolean);
    if (!requested.length || requested.some((s) => !ALLOWED_SCOPES.includes(s))) return { error: 'invalid_scope', status: 400 };
    const code = b64url(randomBytes(32));
    codes.set(code, {
      clientId,
      redirectUri: input.redirect_uri,
      challenge: input.code_challenge,
      scope: requested,
      exp: Date.now() + 60_000
    });
    const back = new URL(input.redirect_uri);
    back.searchParams.set('code', code);
    if (input.state) back.searchParams.set('state', input.state);
    return { redirect: back.toString() };
  }

  function token(input) {
    if (input.client_id !== clientId) return { error: 'unauthorized_client', status: 400 };
    if (input.grant_type === 'authorization_code') {
      const row = codes.get(input.code);
      codes.delete(input.code);
      if (!row || row.exp < Date.now() || row.redirectUri !== input.redirect_uri) return { error: 'invalid_grant', status: 400 };
      const check = b64url(createHash('sha256').update(String(input.code_verifier || '')).digest());
      if (!same(check, row.challenge)) return { error: 'invalid_grant', status: 400 };
      return issue(row.scope, null);
    }
    if (input.grant_type === 'refresh_token') {
      const spent = spentRefresh.get(input.refresh_token);
      if (spent) {
        const family = families.get(spent);
        if (family) family.revoked = true;
        for (const [tok, info] of access) {
          if (info.family === spent) access.delete(tok);
        }
        return { error: 'invalid_grant', status: 400 };
      }
      const row = refresh.get(input.refresh_token);
      if (!row || row.exp < Date.now()) return { error: 'invalid_grant', status: 400 };
      refresh.delete(input.refresh_token);
      spentRefresh.set(input.refresh_token, row.family);
      const family = families.get(row.family);
      if (!family || family.revoked) return { error: 'invalid_grant', status: 400 };
      if (family.current !== input.refresh_token) {
        family.revoked = true;
        for (const [tok, info] of access) {
          if (info.family === row.family) access.delete(tok);
        }
        return { error: 'invalid_grant', status: 400 };
      }
      return issue(row.scope, row.family);
    }
    return { error: 'unsupported_grant', status: 400 };
  }

  function issue(scope, familyId) {
    const accessToken = b64url(randomBytes(32));
    const refreshToken = b64url(randomBytes(32));
    const family = familyId || b64url(randomBytes(16));
    access.set(accessToken, { scope, family, exp: Date.now() + 10 * 60 * 1000 });
    refresh.set(refreshToken, { scope, exp: Date.now() + 14 * 24 * 3600 * 1000, family });
    families.set(family, { current: refreshToken, revoked: false });
    return {
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 600,
      scope: scope.join(' ')
    };
  }

  function introspect(token) {
    const row = access.get(token);
    if (!row || row.exp < Date.now()) return null;
    return { active: true, scope: row.scope, aud: resource };
  }

  function revoke(token) {
    access.delete(token);
    const row = refresh.get(token);
    if (row) {
      refresh.delete(token);
      const family = families.get(row.family);
      if (family) family.revoked = true;
    }
  }

  return { metadata, protectedResource, authorize, token, introspect, revoke };
}
