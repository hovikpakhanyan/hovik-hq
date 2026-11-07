const FORBIDDEN = new Set([
  'owner_id', 'destination', 'sql', 'query', 'credential', 'credentials', 'secret', 'secrets',
  'service_role', 'password', 'api_key', 'access_token', 'project_ref', 'project_id',
  'price', 'quote', 'last', 'bid', 'ask', 'balance', 'shares', 'quantity', 'pnl', 'market_value',
  'nav', 'close', 'open', 'high', 'low', 'volume'
]);

export function forbiddenKey(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = forbiddenKey(item);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) return key;
    const hit = forbiddenKey(value[key]);
    if (hit) return hit;
  }
  return null;
}

export function httpsOk(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host === '0.0.0.0') return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return false;
  return true;
}

export function preflight(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error_code: 'invalid_payload' };
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > 262144) return { ok: false, error_code: 'oversize' };
  const bad = forbiddenKey(payload);
  if (bad) return { ok: false, error_code: 'forbidden_field', field: bad };
  if (payload.schema_version !== 1) return { ok: false, error_code: 'bad_version' };
  if (!/^[0-9a-f-]{36}$/i.test(String(payload.run_id || ''))) return { ok: false, error_code: 'invalid_payload' };
  if (payload.outcome !== 'publish' && payload.outcome !== 'no_change') return { ok: false, error_code: 'invalid_payload' };
  return { ok: true };
}
