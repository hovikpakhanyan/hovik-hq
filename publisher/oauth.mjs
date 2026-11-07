import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function hashToken(raw) {
  return createHash('sha256').update(String(raw)).digest('hex');
}

function same(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const ALLOWED_SCOPES = ['research.publish', 'research.status.read'];
const ACCESS_MS = 10 * 60 * 1000;
const REFRESH_MS = 14 * 24 * 3600 * 1000;
const CODE_MS = 60 * 1000;

export function createMemoryStore() {
  const codes = new Map();
  const access = new Map();
  const refresh = new Map();
  const families = new Map();
  function kill(familyId) {
    const family = families.get(familyId);
    if (family) family.revoked = true;
    for (const [tok, info] of access) if (info.family === familyId) access.delete(tok);
    for (const [tok, info] of refresh) if (info.family === familyId) refresh.delete(tok);
  }
  return {
    async saveCode(row) { codes.set(row.hash, row); },
    async consumeCode(hash) {
      const row = codes.get(hash);
      if (!row || row.used || row.exp < Date.now()) return null;
      row.used = true;
      return row;
    },
    async saveGrant(row) {
      families.set(row.family, { revoked: false });
      access.set(row.accessHash, { family: row.family, scope: row.scope, exp: row.accessExp });
      refresh.set(row.refreshHash, { family: row.family, scope: row.scope, exp: row.refreshExp, consumed: false });
    },
    async rotate(row) {
      const current = refresh.get(row.oldHash);
      if (!current || current.consumed || current.exp < Date.now()) {
        if (current) kill(current.family);
        return { ok: false };
      }
      const family = families.get(current.family);
      if (!family || family.revoked) {
        if (current) kill(current.family);
        return { ok: false };
      }
      current.consumed = true;
      access.set(row.accessHash, { family: current.family, scope: current.scope, exp: row.accessExp });
      refresh.set(row.refreshHash, { family: current.family, scope: current.scope, exp: row.refreshExp, consumed: false });
      return { ok: true, scope: current.scope, family: current.family };
    },
    async introspect(hash) {
      const row = access.get(hash);
      if (!row || row.exp < Date.now()) return null;
      const family = families.get(row.family);
      if (!family || family.revoked) return null;
      return { scope: row.scope };
    },
    async revoke(hash) {
      const accessRow = access.get(hash);
      if (accessRow) kill(accessRow.family);
      const refreshRow = refresh.get(hash);
      if (refreshRow) kill(refreshRow.family);
    }
  };
}

export function createIssuer(options) {
  const clientId = options.clientId;
  const redirectUris = new Set(options.redirectUris || []);
  const bootstrap = options.bootstrapCode;
  const resource = options.resource;
  const store = options.store || createMemoryStore();

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

  async function authorize(input) {
    if (!bootstrap) return { error: 'server_unconfigured', status: 503 };
    if (input.client_id !== clientId) return { error: 'unauthorized_client', status: 400 };
    if (!redirectUris.has(input.redirect_uri)) return { error: 'invalid_redirect', status: 400 };
    if (input.code_challenge_method !== 'S256' || !input.code_challenge) return { error: 'invalid_request', status: 400 };
    if (!same(input.bootstrap || '', bootstrap)) return { error: 'access_denied', status: 401 };
    const requested = String(input.scope || '').split(/\s+/).filter(Boolean);
    if (!requested.length || requested.some((s) => !ALLOWED_SCOPES.includes(s))) return { error: 'invalid_scope', status: 400 };
    const code = b64url(randomBytes(32));
    await store.saveCode({
      hash: hashToken(code),
      clientId,
      redirectUri: input.redirect_uri,
      challenge: input.code_challenge,
      scope: requested,
      exp: Date.now() + CODE_MS
    });
    const back = new URL(input.redirect_uri);
    back.searchParams.set('code', code);
    if (input.state) back.searchParams.set('state', input.state);
    return { redirect: back.toString() };
  }

  async function issue(scope, familyId) {
    const accessToken = b64url(randomBytes(32));
    const refreshToken = b64url(randomBytes(32));
    const family = familyId || crypto.randomUUID();
    const now = Date.now();
    await store.saveGrant({
      accessHash: hashToken(accessToken),
      refreshHash: hashToken(refreshToken),
      family,
      scope,
      accessExp: now + ACCESS_MS,
      refreshExp: now + REFRESH_MS
    });
    return {
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 600,
      scope: scope.join(' ')
    };
  }

  async function token(input) {
    if (input.client_id !== clientId) return { error: 'unauthorized_client', status: 400 };
    if (input.grant_type === 'authorization_code') {
      const row = await store.consumeCode(hashToken(input.code || ''));
      if (!row || row.exp < Date.now() || row.redirectUri !== input.redirect_uri) return { error: 'invalid_grant', status: 400 };
      const check = b64url(createHash('sha256').update(String(input.code_verifier || '')).digest());
      if (!same(check, row.challenge)) return { error: 'invalid_grant', status: 400 };
      return issue(row.scope, null);
    }
    if (input.grant_type === 'refresh_token') {
      const accessToken = b64url(randomBytes(32));
      const refreshToken = b64url(randomBytes(32));
      const now = Date.now();
      const rotated = await store.rotate({
        oldHash: hashToken(input.refresh_token || ''),
        accessHash: hashToken(accessToken),
        refreshHash: hashToken(refreshToken),
        accessExp: now + ACCESS_MS,
        refreshExp: now + REFRESH_MS
      });
      if (!rotated.ok) return { error: 'invalid_grant', status: 400 };
      return {
        token_type: 'Bearer',
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 600,
        scope: rotated.scope.join(' ')
      };
    }
    return { error: 'unsupported_grant', status: 400 };
  }

  async function introspect(raw) {
    const row = await store.introspect(hashToken(raw || ''));
    if (!row) return null;
    return { active: true, scope: row.scope, aud: resource };
  }

  async function revoke(raw) {
    await store.revoke(hashToken(raw || ''));
  }

  return { metadata, protectedResource, authorize, token, introspect, revoke };
}
