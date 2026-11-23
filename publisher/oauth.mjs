import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { consentPage } from './consent.mjs';
import { CLIENT_SCOPES, KEY_SCOPES, generateKey, hashKey, looksLikeKey } from './keys.mjs';

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
const KEY_DEFAULT_MS = 90 * 24 * 3600 * 1000;

export function createMemoryStore() {
  const codes = new Map();
  const access = new Map();
  const refresh = new Map();
  const families = new Map();
  const hits = new Map();
  const keys = new Map();
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
    },
    async hit(bucket, limit, windowSeconds = 600) {
      const now = Date.now();
      const row = hits.get(bucket);
      if (!row || now - row.start > windowSeconds * 1000) {
        hits.set(bucket, { start: now, n: 1 });
        return true;
      }
      if (row.n >= limit) return false;
      row.n += 1;
      return true;
    },
    async purge() {},
    async keyCheck(hash) {
      const row = keys.get(hash);
      if (!row || row.revoked_at || row.expires_at <= Date.now()) return null;
      row.last_used_at = Date.now();
      return { hash: row.key_hash, client: row.client, scope: [...row.scopes] };
    },
    async keyIssue(hash, client, label = '') {
      const scopes = CLIENT_SCOPES[client];
      if (!scopes) return { ok: false, error_code: 'unknown_client' };
      if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, error_code: 'bad_hash' };
      const active = [...keys.values()].filter((k) => k.client === client && !k.revoked_at && k.expires_at > Date.now());
      if (active.length >= 3) return { ok: false, error_code: 'too_many_active_keys' };
      const row = {
        id: crypto.randomUUID(), client, label: String(label || '').slice(0, 80), key_hash: hash, scopes: [...scopes],
        created_at: Date.now(), expires_at: Date.now() + KEY_DEFAULT_MS, revoked_at: null, last_used_at: null
      };
      keys.set(hash, row);
      return { ok: true, id: row.id, client, scopes: row.scopes, expires_at: new Date(row.expires_at).toISOString() };
    },
    async keyList() {
      return [...keys.values()].map(({ key_hash, ...rest }) => ({ ...rest }));
    },
    async keyRevoke(id) {
      for (const row of keys.values()) {
        if (row.id === id && !row.revoked_at) { row.revoked_at = Date.now(); return true; }
      }
      return false;
    },
    // Test helper: expire or inspect rows without exposing them to callers.
    _keys: keys
  };
}

export function createIssuer(options) {
  const clientId = options.clientId;
  const redirectUris = new Set(options.redirectUris || []);
  const bootstrap = options.bootstrapCode;
  const resource = options.resource;
  const store = options.store || createMemoryStore();

  function metadata() {
    const origin = String(resource || '').replace(/\/$/, '');
    return {
      issuer: origin,
      authorization_endpoint: origin + '/oauth/authorize',
      token_endpoint: origin + '/oauth/token',
      revocation_endpoint: origin + '/oauth/revoke',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ALLOWED_SCOPES,
      token_endpoint_auth_methods_supported: ['none']
    };
  }

  const limits = {
    authorize: options.limits?.authorize ?? 20,
    token: options.limits?.token ?? 60,
    keys: options.limits?.keys ?? 20,
    keyFail: options.limits?.keyFail ?? 60,
    windowSeconds: options.limits?.windowSeconds ?? 600
  };
  const origin = String(resource || '').replace(/\/$/, '');

  function protectedResource() {
    return {
      resource: origin + '/mcp',
      authorization_servers: [origin],
      scopes_supported: ALLOWED_SCOPES,
      bearer_methods_supported: ['header']
    };
  }

  function challenge(error = 'invalid_token', scope = ALLOWED_SCOPES.join(' ')) {
    return `Bearer error="${error}", resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${scope}"`;
  }

  function checkRequest(input) {
    if (!bootstrap) return { error: 'server_unconfigured', status: 503 };
    if (input.response_type && input.response_type !== 'code') return { error: 'unsupported_response_type', status: 400 };
    if (input.client_id !== clientId) return { error: 'unauthorized_client', status: 400 };
    if (!redirectUris.has(input.redirect_uri)) return { error: 'invalid_redirect', status: 400 };
    if (input.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(String(input.code_challenge || ''))) {
      return { error: 'invalid_request', status: 400 };
    }
    const requested = String(input.scope || '').split(/\s+/).filter(Boolean);
    if (!requested.length || requested.some((s) => !ALLOWED_SCOPES.includes(s))) return { error: 'invalid_scope', status: 400 };
    if (input.state && /[\u0000-\u001f\u007f]/.test(String(input.state))) return { error: 'invalid_request', status: 400 };
    return { ok: true, requested };
  }

  function consent(input) {
    const gate = checkRequest(input);
    if (!gate.ok) return gate;
    return {
      html: consentPage({
        response_type: 'code',
        client_id: input.client_id,
        redirect_uri: input.redirect_uri,
        code_challenge: input.code_challenge,
        code_challenge_method: 'S256',
        scope: gate.requested.join(' '),
        state: input.state || ''
      })
    };
  }

  async function limited(kind, client) {
    const cap = limits[kind];
    const specific = await store.hit(kind + ':' + client, cap, limits.windowSeconds);
    const overall = await store.hit(kind, cap * 2, limits.windowSeconds);
    return specific && overall;
  }

  async function authorize(input) {
    const gate = checkRequest(input);
    if (!gate.ok) return gate;
    if (!(await limited('authorize', input.client_id))) return { error: 'rate_limited', status: 429 };
    if (!same(input.bootstrap || '', bootstrap)) return { error: 'access_denied', status: 401 };
    const requested = gate.requested;
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
    if (store.purge) await store.purge();
    if (!(await limited('token', input.client_id))) return { error: 'rate_limited', status: 429 };
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

  // Long-lived publisher key. Returns null for an unknown, revoked, or expired
  // key, and { limited: true } once failed key attempts pass the shared limit.
  async function introspectKey(raw) {
    if (!looksLikeKey(raw) || !store.keyCheck) return failKey();
    const hash = hashKey(raw);
    const row = await store.keyCheck(hash);
    if (!row || !same(row.hash, hash)) return failKey();
    const scope = (row.scope || []).filter((s) => KEY_SCOPES.includes(s));
    if (!scope.length) return failKey();
    return { active: true, via: 'key', client: row.client, scope, aud: resource };
  }

  async function failKey() {
    const ok = await store.hit('mcp_key_fail', limits.keyFail, limits.windowSeconds);
    return ok ? null : { limited: true };
  }

  // Owner gate for /publisher/keys: same rate limiting and exact compare as consent.
  async function ownerGate(code) {
    if (!bootstrap) return { error: 'server_unconfigured', status: 503 };
    if (!(await limited('keys', 'owner'))) return { error: 'rate_limited', status: 429 };
    if (!same(code || '', bootstrap)) return { error: 'access_denied', status: 401 };
    return { ok: true };
  }

  async function issueKey(client, label) {
    if (!CLIENT_SCOPES[client]) return { ok: false, error_code: 'unknown_client' };
    const key = generateKey();
    const result = await store.keyIssue(hashKey(key), client, label || '');
    if (!result || !result.ok) return result || { ok: false, error_code: 'unavailable' };
    return { ...result, key };
  }

  async function listKeys() {
    return store.keyList ? store.keyList() : [];
  }

  async function revokeKey(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return false;
    return store.keyRevoke ? store.keyRevoke(String(id)) : false;
  }

  return { metadata, protectedResource, challenge, consent, authorize, token, introspect, revoke, introspectKey, ownerGate, issueKey, listKeys, revokeKey };
}
