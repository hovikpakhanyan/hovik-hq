import { DEAL_READ, DEAL_WRITE, RESEARCH_TOOLS } from './keys.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{1,80}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const CENTS_CAP = 900000000000000;

const FORBIDDEN = new Set([
  'owner_id', 'destination', 'sql', 'query', 'credential', 'credentials', 'secret', 'secrets',
  'service_role', 'password', 'api_key', 'access_token', 'project_ref', 'project_id',
  'quote', 'last', 'bid', 'ask', 'balance', 'shares', 'quantity', 'pnl', 'market_value',
  'nav', 'close', 'open', 'high', 'low', 'volume', 'price',
  'order', 'trade', 'execute', 'broker', 'side'
]);

const DEAL_FIELDS = [
  'external_key', 'title', 'status_label', 'lane', 'note',
  'price_cents', 'net_est_cents', 'closed_on', 'updated_at', 'archive'
];
const TASK_FIELDS = ['id', 'external_key', 'subject', 'note', 'priority', 'completed', 'completed_at'];
const NOTE_FIELDS = ['id', 'external_key', 'body', 'source', 'status'];
const WATCH_FIELDS = ['id', 'symbol', 'bucket', 'asset_type', 'source_note', 'sort_order'];
const PLAN_FIELDS = ['title', 'body', 'source'];
const NOTE_SOURCES = new Set(['hq', 'conductor', 'export', 'owner']);
const PLAN_SOURCES = new Set(['investment-plan.md', 'owner']);
const ASSET_TYPES = new Set(['equity', 'etf', 'fund', 'cash', 'other']);
const BUCKETS = new Set(['holding', 'watch', 'candidate']);

const DEAL_LANES = {
  listing: new Set(['current', 'upcoming', 'sold']),
  pipeline: new Set(['pipeline']),
  escrow: new Set(['escrow'])
};

function fail(error_code, field) {
  return field ? { ok: false, error_code, field } : { ok: false, error_code };
}

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

function objectBody(args, allowed, cap) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('invalid_payload');
  if (Buffer.byteLength(JSON.stringify(args)) > cap) return fail('oversize');
  const bad = forbiddenKey(args);
  if (bad) return fail('forbidden_field', bad);
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) return fail('invalid_payload');
  }
  return null;
}

function centsOk(value) {
  if (value == null) return true;
  return Number.isSafeInteger(value) && value >= 0 && value <= CENTS_CAP;
}

function dateOk(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function timeOk(value, { required } = {}) {
  if (value == null || value === '') return required ? fail('invalid_payload') : null;
  if (typeof value !== 'string') return fail('invalid_payload');
  const updated = new Date(value);
  if (Number.isNaN(updated.getTime())) return fail('invalid_payload');
  const drift = updated.getTime() - Date.now();
  if (drift > 2 * 60 * 1000) return fail('future_timestamp');
  if (drift < -10 * 365 * 24 * 3600 * 1000) return fail('too_old');
  return null;
}

function limitOf(args) {
  if (args.limit == null) return 20;
  if (!Number.isInteger(args.limit)) return null;
  if (args.limit < 1 || args.limit > 50) return null;
  return args.limit;
}

function dealKind(name) {
  if (name.endsWith('_listings') || name.endsWith('_listing')) return 'listing';
  if (name.endsWith('_pipeline')) return 'pipeline';
  if (name.endsWith('_escrow')) return 'escrow';
  return null;
}

function checkDeal(kind, args, action) {
  const gate = objectBody(args, DEAL_FIELDS, 8192);
  if (gate) return gate;
  if (!KEY.test(String(args.external_key || ''))) return fail('invalid_payload');
  if (!centsOk(args.price_cents) || !centsOk(args.net_est_cents)) return fail('invalid_payload');
  if (args.note != null && (typeof args.note !== 'string' || args.note.length > 2000)) return fail('invalid_payload');
  if (args.title != null && (typeof args.title !== 'string' || args.title.trim().length < 1 || args.title.trim().length > 180)) {
    return fail('invalid_payload');
  }
  if (args.status_label != null && (typeof args.status_label !== 'string' || args.status_label.trim().length < 1 || args.status_label.trim().length > 80)) {
    return fail('invalid_payload');
  }
  if (args.lane != null && !DEAL_LANES[kind].has(args.lane)) return fail('invalid_payload');
  if (args.closed_on != null && args.closed_on !== '' && !dateOk(args.closed_on)) return fail('invalid_payload');
  const lane = args.lane;
  if (args.closed_on && lane && lane !== 'sold') return fail('invalid_payload');
  if (args.archive != null && typeof args.archive !== 'boolean') return fail('invalid_payload');
  const stamp = timeOk(args.updated_at, { required: action === 'create' });
  if (stamp) return stamp;
  if (action === 'create') {
    if (args.archive === true) return fail('invalid_payload');
    if (!args.title || !args.status_label || !args.lane) return fail('invalid_payload');
    if (args.closed_on && args.lane !== 'sold') return fail('invalid_payload');
  } else {
    const mutable = ['title', 'status_label', 'lane', 'note', 'price_cents', 'net_est_cents', 'closed_on', 'updated_at', 'archive'];
    if (!mutable.some((key) => Object.prototype.hasOwnProperty.call(args, key))) return fail('invalid_payload');
  }
  return null;
}

function checkTask(args, action) {
  const gate = objectBody(args, TASK_FIELDS, 20000);
  if (gate) return gate;
  if (action === 'delete' || action === 'update') {
    if (!UUID.test(String(args.id || ''))) return fail('invalid_payload');
  } else if (args.id != null) return fail('invalid_payload');
  if (args.external_key != null && !KEY.test(String(args.external_key))) return fail('invalid_payload');
  if (args.subject != null && (typeof args.subject !== 'string' || args.subject.trim().length < 1 || args.subject.trim().length > 180)) {
    return fail('invalid_payload');
  }
  if (args.note != null && (typeof args.note !== 'string' || args.note.length > 4000)) return fail('invalid_payload');
  if (args.priority != null && (typeof args.priority !== 'string' || args.priority.length > 40)) return fail('invalid_payload');
  if (args.completed != null && typeof args.completed !== 'boolean') return fail('invalid_payload');
  const stamp = timeOk(args.completed_at, { required: false });
  if (stamp) return stamp;
  if (action === 'create' && !args.subject) return fail('invalid_payload');
  if (action === 'update') {
    const mutable = ['external_key', 'subject', 'note', 'priority', 'completed', 'completed_at'];
    if (!mutable.some((key) => Object.prototype.hasOwnProperty.call(args, key))) return fail('invalid_payload');
  }
  return null;
}

function checkNote(args, action) {
  const gate = objectBody(args, NOTE_FIELDS, 20000);
  if (gate) return gate;
  if (action === 'delete' || action === 'update') {
    if (!UUID.test(String(args.id || ''))) return fail('invalid_payload');
  } else if (args.id != null) return fail('invalid_payload');
  if (args.external_key != null && !KEY.test(String(args.external_key))) return fail('invalid_payload');
  if (args.body != null && (typeof args.body !== 'string' || args.body.length < 1 || args.body.length > 4000)) return fail('invalid_payload');
  if (args.source != null && !NOTE_SOURCES.has(args.source)) return fail('invalid_payload');
  if (args.status != null && args.status !== 'open' && args.status !== 'archived') return fail('invalid_payload');
  if (action === 'create' && !args.body) return fail('invalid_payload');
  if (action === 'update') {
    const mutable = ['external_key', 'body', 'source', 'status'];
    if (!mutable.some((key) => Object.prototype.hasOwnProperty.call(args, key))) return fail('invalid_payload');
  }
  return null;
}

function checkWatch(args, action) {
  const gate = objectBody(args, WATCH_FIELDS, 4096);
  if (gate) return gate;
  if (action === 'delete' || action === 'update') {
    if (!UUID.test(String(args.id || ''))) return fail('invalid_payload');
  } else if (args.id != null) return fail('invalid_payload');
  if (args.symbol != null && !SYMBOL.test(String(args.symbol))) return fail('invalid_payload');
  if (args.bucket != null && !BUCKETS.has(args.bucket)) return fail('invalid_payload');
  if (args.asset_type != null && !ASSET_TYPES.has(args.asset_type)) return fail('invalid_payload');
  if (args.source_note != null && (typeof args.source_note !== 'string' || args.source_note.length > 300)) return fail('invalid_payload');
  if (args.sort_order != null && (!Number.isInteger(args.sort_order) || args.sort_order < -1000000 || args.sort_order > 1000000)) {
    return fail('invalid_payload');
  }
  if (action === 'create' && (!args.symbol || !args.bucket)) return fail('invalid_payload');
  if (action === 'update') {
    const mutable = ['symbol', 'bucket', 'asset_type', 'source_note', 'sort_order'];
    if (!mutable.some((key) => Object.prototype.hasOwnProperty.call(args, key))) return fail('invalid_payload');
  }
  return null;
}

function checkPlan(args, action) {
  const gate = objectBody(args, PLAN_FIELDS, 80000);
  if (gate) return gate;
  if (args.title != null && (typeof args.title !== 'string' || args.title.trim().length < 1 || args.title.trim().length > 180)) {
    return fail('invalid_payload');
  }
  if (args.body != null && (typeof args.body !== 'string' || args.body.length < 1 || args.body.length > 65536)) return fail('invalid_payload');
  if (args.source != null && !PLAN_SOURCES.has(args.source)) return fail('invalid_payload');
  if (action === 'create' && (!args.title || !args.body)) return fail('invalid_payload');
  if (action === 'update') {
    if (!['title', 'body', 'source'].some((key) => Object.prototype.hasOwnProperty.call(args, key))) return fail('invalid_payload');
  }
  return null;
}

const DOMAIN = [
  ['list_listings', 'listings.read', 'List listing records for the HQ owner. Archived rows stay hidden unless include_archived is true. No quotes and no trade.'],
  ['get_listing', 'listings.read', 'Read one listing by external_key, including an archived row. No quotes and no trade.'],
  ['create_listing', 'listings.write', 'Create one listing. external_key is the stable id. Sending an existing key is rejected. Amounts are integer cents. No delete and no trade.'],
  ['update_listing', 'listings.write', 'Update one listing by external_key. Set archive true to hide it. This does not delete the row and does not trade.'],
  ['list_pipeline', 'pipeline.read', 'List pipeline records for the HQ owner. Archived rows stay hidden unless include_archived is true.'],
  ['get_pipeline', 'pipeline.read', 'Read one pipeline record by external_key.'],
  ['create_pipeline', 'pipeline.write', 'Create one pipeline record. An existing external_key is rejected. Amounts are integer cents. No trade.'],
  ['update_pipeline', 'pipeline.write', 'Update one pipeline record by external_key. Set archive true to hide it. This does not delete the row.'],
  ['list_escrow', 'escrow.read', 'List escrow records for the HQ owner. Archived rows stay hidden unless include_archived is true.'],
  ['get_escrow', 'escrow.read', 'Read one escrow record by external_key.'],
  ['create_escrow', 'escrow.write', 'Create one escrow record. An existing external_key is rejected. Amounts are integer cents. No trade.'],
  ['update_escrow', 'escrow.write', 'Update one escrow record by external_key. Set archive true to hide it. This does not delete the row.'],
  ['list_tasks', 'tasks.read', 'List the owner\'s HQ tasks, newest first.'],
  ['get_task', 'tasks.read', 'Read one HQ task by id.'],
  ['create_task', 'tasks.write', 'Create one HQ task. The server assigns the id.'],
  ['update_task', 'tasks.write', 'Update one HQ task by id.'],
  ['delete_task', 'tasks.write', 'Delete one HQ task by id. Listings, pipeline, and escrow cannot be deleted this way.'],
  ['list_notes', 'notes.read', 'List the owner\'s HQ notes, newest first.'],
  ['get_note', 'notes.read', 'Read one HQ note by id.'],
  ['create_note', 'notes.write', 'Create one HQ note. This does not send a message and does not trade.'],
  ['update_note', 'notes.write', 'Update one HQ note by id. status archived hides it without deleting it.'],
  ['delete_note', 'notes.write', 'Delete one HQ note by id.'],
  ['list_watchlist', 'watchlist.read', 'List the owner\'s watchlist. Symbols only. No sizes, balances, or quotes.'],
  ['get_watchlist', 'watchlist.read', 'Read one watchlist row by id, or by symbol and bucket.'],
  ['create_watchlist', 'watchlist.write', 'Add one watchlist row. No size, balance, or quote.'],
  ['update_watchlist', 'watchlist.write', 'Update one watchlist row by id. No size, balance, or quote.'],
  ['delete_watchlist', 'watchlist.write', 'Remove one watchlist membership by id. This does not delete a listing, escrow, or trade.'],
  ['list_plan', 'plan.read', 'Read the owner\'s investment plan markdown. It is not a trade instruction.'],
  ['get_plan', 'plan.read', 'Read the owner\'s investment plan. Pass id to require that row.'],
  ['create_plan', 'plan.write', 'Store the investment plan markdown once. A second create is rejected. No trades are placed.'],
  ['update_plan', 'plan.write', 'Replace the stored investment plan text. No trades are placed.']
];

const DOMAIN_SCOPE = Object.freeze(Object.fromEntries(DOMAIN.map(([name, scope]) => [name, scope])));

function schemaFor(name) {
  const dealList = {
    type: 'object', additionalProperties: false,
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      include_archived: { type: 'boolean' }
    }
  };
  const dealGet = {
    type: 'object', additionalProperties: false, required: ['external_key'],
    properties: { external_key: { type: 'string' } }
  };
  const dealWrite = {
    type: 'object', additionalProperties: false, required: ['external_key'],
    properties: {
      external_key: { type: 'string' },
      title: { type: 'string' },
      status_label: { type: 'string' },
      lane: { type: 'string' },
      note: { type: 'string' },
      price_cents: { type: 'integer', minimum: 0 },
      net_est_cents: { type: 'integer', minimum: 0 },
      closed_on: { type: 'string' },
      updated_at: { type: 'string' },
      archive: { type: 'boolean' }
    }
  };
  if (name.startsWith('list_') && (name.includes('listing') || name.includes('pipeline') || name.includes('escrow'))) return dealList;
  if (name.startsWith('get_') && (name.includes('listing') || name.includes('pipeline') || name.includes('escrow'))) return dealGet;
  if (name.startsWith('create_') && (name.includes('listing') || name.includes('pipeline') || name.includes('escrow'))) {
    return { ...dealWrite, required: ['external_key', 'title', 'status_label', 'lane', 'updated_at'] };
  }
  if (name.startsWith('update_') && (name.includes('listing') || name.includes('pipeline') || name.includes('escrow'))) return dealWrite;
  if (name === 'list_tasks') {
    return { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 50 }, completed: { type: 'boolean' } } };
  }
  if (name === 'get_task' || name === 'delete_task' || name === 'get_note' || name === 'delete_note' || name === 'delete_watchlist') {
    return { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } };
  }
  if (name === 'list_notes' || name === 'list_plan') {
    return { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } };
  }
  if (name === 'get_plan') {
    return { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } };
  }
  if (name === 'list_watchlist') {
    return {
      type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50 }, symbol: { type: 'string' }, bucket: { type: 'string' } }
    };
  }
  if (name === 'get_watchlist') {
    return { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, symbol: { type: 'string' }, bucket: { type: 'string' } } };
  }
  if (name === 'create_task' || name === 'update_task') {
    return {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string' }, external_key: { type: 'string' }, subject: { type: 'string' },
        note: { type: 'string' }, priority: { type: 'string' }, completed: { type: 'boolean' }, completed_at: { type: 'string' }
      }
    };
  }
  if (name === 'create_note' || name === 'update_note') {
    return {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, external_key: { type: 'string' }, body: { type: 'string' }, source: { type: 'string' }, status: { type: 'string' } }
    };
  }
  if (name === 'create_watchlist' || name === 'update_watchlist') {
    return {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string' }, symbol: { type: 'string' }, bucket: { type: 'string' },
        asset_type: { type: 'string' }, source_note: { type: 'string' }, sort_order: { type: 'integer' }
      }
    };
  }
  return {
    type: 'object', additionalProperties: false,
    properties: { title: { type: 'string' }, body: { type: 'string' }, source: { type: 'string' } }
  };
}

export const domainToolDefs = Object.freeze(DOMAIN.map(([name, scope, description]) => Object.freeze({
  name, scope, description, inputSchema: schemaFor(name)
})));

export function knownKeyTool(name) {
  return Boolean(RESEARCH_TOOLS[name] || name === 'publish_deal' || name === 'deal_status' || DOMAIN_SCOPE[name]);
}

export function keyMayCall(name, scope) {
  const list = Array.isArray(scope) ? scope : [];
  if (RESEARCH_TOOLS[name]) return list.includes(RESEARCH_TOOLS[name]);
  if (name === 'publish_deal') return Object.values(DEAL_WRITE).some((item) => list.includes(item));
  if (name === 'deal_status') return Object.values(DEAL_READ).some((item) => list.includes(item));
  if (DOMAIN_SCOPE[name]) return list.includes(DOMAIN_SCOPE[name]);
  return false;
}

export function dealWriteScope(kind) {
  return DEAL_WRITE[kind] || null;
}

export function readableDealKinds(scope) {
  const list = Array.isArray(scope) ? scope : [];
  return Object.keys(DEAL_READ).filter((kind) => list.includes(DEAL_READ[kind]));
}

function listLimit(args) {
  const gate = objectBody(args, Object.keys(args), 4096);
  if (gate) return gate;
  const limit = limitOf(args);
  if (limit == null) return fail('invalid_payload');
  return { limit };
}

// Returns null when name is not a domain tool. Otherwise { ok:true, fn, args, scope, write }.
export function prepareDomain(name, args) {
  const scope = DOMAIN_SCOPE[name];
  if (!scope) return null;
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const kind = dealKind(name);
  if (kind && (name.startsWith('list_') || name.startsWith('get_'))) {
    const gate = objectBody(input, name.startsWith('list_') ? ['limit', 'include_archived'] : ['external_key'], 4096);
    if (gate) return gate;
    if (name.startsWith('get_')) {
      if (!KEY.test(String(input.external_key || ''))) return fail('invalid_payload');
      return { ok: true, fn: 'deal_rows', args: [kind, input.external_key, 1, true], scope, write: false };
    }
    const limit = limitOf(input);
    if (limit == null) return fail('invalid_payload');
    if (input.include_archived != null && typeof input.include_archived !== 'boolean') return fail('invalid_payload');
    return { ok: true, fn: 'deal_rows', args: [kind, null, limit, input.include_archived === true], scope, write: false };
  }
  if (kind && (name.startsWith('create_') || name.startsWith('update_'))) {
    const action = name.startsWith('create_') ? 'create' : 'update';
    const gate = checkDeal(kind, input, action);
    if (gate) return gate;
    return { ok: true, fn: 'deal_mutate', args: [kind, action, input], scope, write: true };
  }
  if (name === 'list_tasks' || name === 'get_task') {
    if (name === 'get_task') {
      const gate = objectBody(input, ['id'], 4096);
      if (gate) return gate;
      if (!UUID.test(String(input.id || ''))) return fail('invalid_payload');
      return { ok: true, fn: 'task_rows', args: [input.id, 1, null], scope, write: false };
    }
    const gate = objectBody(input, ['limit', 'completed'], 4096);
    if (gate) return gate;
    const limit = limitOf(input);
    if (limit == null) return fail('invalid_payload');
    if (input.completed != null && typeof input.completed !== 'boolean') return fail('invalid_payload');
    return { ok: true, fn: 'task_rows', args: [null, limit, input.completed == null ? null : input.completed], scope, write: false };
  }
  if (name === 'create_task' || name === 'update_task' || name === 'delete_task') {
    const action = name.slice(0, name.indexOf('_'));
    const gate = checkTask(input, action);
    if (gate) return gate;
    return { ok: true, fn: 'task_mutate', args: [action, input], scope, write: true };
  }
  if (name === 'list_notes' || name === 'get_note') {
    if (name === 'get_note') {
      const gate = objectBody(input, ['id'], 4096);
      if (gate) return gate;
      if (!UUID.test(String(input.id || ''))) return fail('invalid_payload');
      return { ok: true, fn: 'note_rows', args: [input.id, 1], scope, write: false };
    }
    const limited = listLimit(input);
    if (!limited.limit) return limited;
    const extra = Object.keys(input).filter((key) => key !== 'limit');
    if (extra.length) return fail('invalid_payload');
    return { ok: true, fn: 'note_rows', args: [null, limited.limit], scope, write: false };
  }
  if (name === 'create_note' || name === 'update_note' || name === 'delete_note') {
    const action = name.slice(0, name.indexOf('_'));
    const gate = checkNote(input, action);
    if (gate) return gate;
    return { ok: true, fn: 'note_mutate', args: [action, input], scope, write: true };
  }
  if (name === 'list_watchlist' || name === 'get_watchlist') {
    if (name === 'get_watchlist') {
      const gate = objectBody(input, ['id', 'symbol', 'bucket'], 4096);
      if (gate) return gate;
      const byId = input.id != null;
      if (byId && !UUID.test(String(input.id))) return fail('invalid_payload');
      if (!byId && (!SYMBOL.test(String(input.symbol || '')) || !BUCKETS.has(input.bucket))) return fail('invalid_payload');
      if (byId && (input.symbol != null || input.bucket != null)) return fail('invalid_payload');
      return { ok: true, fn: 'watch_rows', args: [byId ? input.id : null, byId ? null : input.symbol, byId ? null : input.bucket, null], scope, write: false };
    }
    const gate = objectBody(input, ['limit', 'symbol', 'bucket'], 4096);
    if (gate) return gate;
    const limit = limitOf(input);
    if (limit == null) return fail('invalid_payload');
    if (input.symbol != null && !SYMBOL.test(String(input.symbol))) return fail('invalid_payload');
    if (input.bucket != null && !BUCKETS.has(input.bucket)) return fail('invalid_payload');
    return { ok: true, fn: 'watch_rows', args: [null, input.symbol || null, input.bucket || null, limit], scope, write: false };
  }
  if (name === 'create_watchlist' || name === 'update_watchlist' || name === 'delete_watchlist') {
    const action = name.slice(0, name.indexOf('_'));
    const gate = checkWatch(input, action);
    if (gate) return gate;
    return { ok: true, fn: 'watch_mutate', args: [action, input], scope, write: true };
  }
  if (name === 'list_plan' || name === 'get_plan') {
    const gate = objectBody(input, name === 'get_plan' ? ['id'] : ['limit'], 4096);
    if (gate) return gate;
    if (name === 'get_plan' && input.id != null && !UUID.test(String(input.id))) return fail('invalid_payload');
    if (name === 'list_plan' && input.limit != null && limitOf(input) == null) return fail('invalid_payload');
    return { ok: true, fn: 'plan_read', args: [name === 'get_plan' ? (input.id || null) : null], scope, write: false };
  }
  if (name === 'create_plan' || name === 'update_plan') {
    const action = name.startsWith('create_') ? 'create' : 'update';
    const gate = checkPlan(input, action);
    if (gate) return gate;
    return { ok: true, fn: 'plan_mutate', args: [action, input], scope, write: true };
  }
  return fail('invalid_payload');
}
