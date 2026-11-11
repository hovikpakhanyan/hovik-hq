const FORBIDDEN = new Set([
  'owner_id', 'destination', 'sql', 'query', 'credential', 'credentials', 'secret', 'secrets',
  'service_role', 'password', 'api_key', 'access_token', 'project_ref', 'project_id',
  'quote', 'last', 'bid', 'ask', 'balance', 'shares', 'quantity', 'pnl', 'market_value',
  'nav', 'close', 'open', 'high', 'low', 'volume', 'price'
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{1,80}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const CENTS_CAP = 900000000000000;

function forbiddenKey(value) {
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

function centsOk(value) {
  if (value == null) return true;
  return Number.isSafeInteger(value) && value >= 0 && value <= CENTS_CAP;
}

function dateOk(value) {
  if (!DATE.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function dealPreflight(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error_code: 'invalid_payload' };
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > 65536) return { ok: false, error_code: 'oversize' };
  const bad = forbiddenKey(payload);
  if (bad) return { ok: false, error_code: 'forbidden_field', field: bad };
  if (payload.schema_version !== 1) return { ok: false, error_code: 'bad_version' };
  if (!UUID.test(String(payload.record_id || ''))) return { ok: false, error_code: 'invalid_payload' };
  if (!KEY.test(String(payload.external_key || ''))) return { ok: false, error_code: 'invalid_payload' };
  const kind = payload.kind;
  const lane = payload.lane;
  const laneOk = (kind === 'listing' && (lane === 'current' || lane === 'upcoming' || lane === 'sold'))
    || (kind === 'pipeline' && lane === 'pipeline')
    || (kind === 'escrow' && lane === 'escrow');
  if (!laneOk) return { ok: false, error_code: 'invalid_payload' };
  const title = String(payload.title || '').trim();
  const status = String(payload.status_label || '').trim();
  if (!title || title.length > 180 || !status || status.length > 80) return { ok: false, error_code: 'invalid_payload' };
  if (payload.note != null && (typeof payload.note !== 'string' || payload.note.length > 2000)) {
    return { ok: false, error_code: 'invalid_payload' };
  }
  if (!centsOk(payload.price_cents) || !centsOk(payload.net_est_cents)) return { ok: false, error_code: 'invalid_payload' };
  if (payload.closed_on != null && payload.closed_on !== '') {
    if (lane !== 'sold' || !dateOk(payload.closed_on)) return { ok: false, error_code: 'invalid_payload' };
  }
  const updated = new Date(payload.updated_at);
  if (Number.isNaN(updated.getTime())) return { ok: false, error_code: 'invalid_payload' };
  const drift = updated.getTime() - Date.now();
  if (drift > 2 * 60 * 1000) return { ok: false, error_code: 'future_timestamp' };
  if (drift < -10 * 365 * 24 * 3600 * 1000) return { ok: false, error_code: 'too_old' };
  return { ok: true };
}
