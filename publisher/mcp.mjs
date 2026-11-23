import { preflight } from './validate.mjs';
import { dealPreflight } from './deals.mjs';
import { KEY_PREFIX } from './keys.mjs';
import { dealWriteScope, domainToolDefs, keyMayCall, knownKeyTool, prepareDomain, readableDealKinds } from './hq-tools.mjs';

const TOOLS = [
  {
    name: 'publish_stock_research',
    description: 'Publish one sourced research run to the fixed HQ project. Owner, destination, SQL, and prices are not arguments.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['schema_version', 'run_id', 'researched_at', 'outcome'],
      properties: {
        schema_version: { const: 1 },
        run_id: { type: 'string' },
        researched_at: { type: 'string' },
        outcome: { enum: ['publish', 'no_change'] },
        instruments: { type: 'array' },
        findings: { type: 'array' }
      }
    }
  },
  {
    name: 'research_status',
    description: 'Read the latest ingestion receipt for the fixed HQ project. No findings body and no secrets.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { run_id: { type: 'string' } }
    }
  },
  {
    name: 'publish_deal',
    description: 'Create or update one listing, pipeline, or escrow record for the fixed HQ owner. external_key is the stable id. record_id is this publication. Amounts are integer cents from the source record, not market quotes. Owner, SQL, secrets, and quote fields are rejected. This does not place a trade.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['schema_version', 'record_id', 'external_key', 'kind', 'lane', 'title', 'status_label', 'updated_at'],
      properties: {
        schema_version: { const: 1 },
        record_id: { type: 'string' },
        external_key: { type: 'string' },
        kind: { enum: ['listing', 'pipeline', 'escrow'] },
        lane: { enum: ['current', 'upcoming', 'sold', 'pipeline', 'escrow'] },
        title: { type: 'string' },
        status_label: { type: 'string' },
        price_cents: { type: 'integer', minimum: 0 },
        net_est_cents: { type: 'integer', minimum: 0 },
        closed_on: { type: 'string' },
        note: { type: 'string' },
        updated_at: { type: 'string' }
      }
    }
  },
  {
    name: 'deal_status',
    description: 'Read deal publication counts, or one record by external_key. No secrets and no note body. Archived rows are omitted from counts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { external_key: { type: 'string' } }
    }
  }
];

// Read-only tool for publisher keys that carry research.read. Not offered to
// OAuth sessions, whose scopes are unchanged.
const READ_TOOL = {
  name: 'read_stock_research',
  description: 'Read the HQ owner\'s own published stock research notes, newest first. Read-only. No watchlist, deal, listing, pipeline, or escrow data.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      symbol: { type: 'string' },
      run_id: { type: 'string' }
    }
  }
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{1,80}$/;
const CATALOG = [...TOOLS, READ_TOOL, ...domainToolDefs];

function keyTools(scope) {
  return CATALOG.filter((tool) => keyMayCall(tool.name, scope)).map(({ scope: _scope, ...tool }) => tool);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function toolText(id, result) {
  return { status: 200, body: rpcResult(id, { isError: result.ok === false, content: [{ type: 'text', text: JSON.stringify(result) }] }) };
}
function denied(id, auth, scope) {
  return {
    status: 403,
    headers: scope
      ? { 'www-authenticate': auth.challenge('insufficient_scope', scope), 'cache-control': 'no-store' }
      : { 'cache-control': 'no-store' },
    body: rpcError(id, -32001, 'insufficient_scope')
  };
}

export async function handleMcp({ auth, db, body, authorization }) {
  const header = String(authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  let session = null;
  if (token.startsWith(KEY_PREFIX) && auth.introspectKey) {
    session = await auth.introspectKey(token);
    if (session && session.limited) {
      return { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': '600' }, body: { error: 'rate_limited' } };
    }
  } else if (token) {
    session = await auth.introspect(token);
  }
  if (!session) {
    return {
      status: 401,
      headers: {
        'www-authenticate': auth.challenge ? auth.challenge('invalid_token') : 'Bearer error="invalid_token"',
        'cache-control': 'no-store'
      },
      body: { error: 'invalid_token' }
    };
  }
  let message;
  try { message = typeof body === 'string' ? JSON.parse(body) : body; }
  catch { return { status: 400, body: rpcError(null, -32700, 'parse error') }; }
  const id = message.id ?? null;
  if (message.method === 'initialize') {
    return { status: 200, body: rpcResult(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'hq-research-publisher', version: '1.0.0' }
    }) };
  }
  if (message.method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: session.via === 'key' ? keyTools(session.scope) : TOOLS }) };
  }
  if (message.method === 'tools/call') {
    const name = message.params && message.params.name;
    const args = (message.params && message.params.arguments) || {};
    if (session.via === 'key' && !keyMayCall(name, session.scope)) {
      if (knownKeyTool(name)) return denied(id, auth);
      return { status: 200, body: rpcError(id, -32601, 'unknown tool') };
    }
    const domain = prepareDomain(name, args);
    if (domain) {
      if (session.via !== 'key') return denied(id, auth);
      if (!domain.ok) return toolText(id, domain);
      if (domain.write && !session.keyId) return denied(id, auth);
      const callArgs = domain.write ? [...domain.args, session.client, session.keyId] : domain.args;
      const result = await db.domain({ fn: domain.fn, args: callArgs });
      if (result && result.error_code === 'insufficient_scope') return denied(id, auth);
      return toolText(id, result);
    }
    if (name === 'read_stock_research') {
      if (session.via !== 'key' || !session.scope.includes('research.read')) {
        return denied(id, auth);
      }
      if (args.owner_id || args.destination || args.sql) {
        return toolText(id, { ok: false, error_code: 'forbidden_field' });
      }
      const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 50) : 20;
      const symbol = typeof args.symbol === 'string' && /^[A-Z][A-Z0-9.]{0,9}$/.test(args.symbol) ? args.symbol : null;
      if (args.symbol !== undefined && !symbol) return toolText(id, { ok: false, error_code: 'bad_symbol' });
      const runId = typeof args.run_id === 'string' && UUID.test(args.run_id) ? args.run_id : null;
      if (args.run_id !== undefined && !runId) return toolText(id, { ok: false, error_code: 'bad_run_id' });
      const result = await db.readResearch({ limit, symbol, runId });
      return toolText(id, result);
    }
    if (name === 'publish_stock_research') {
      if (!session.scope.includes('research.publish')) return denied(id, auth, 'research.publish');
      const gate = preflight(args);
      if (!gate.ok) return toolText(id, gate);
      const result = await db.publish(args);
      return toolText(id, result);
    }
    if (name === 'research_status') {
      if (!session.scope.includes('research.status.read')) return denied(id, auth);
      if (args.owner_id || args.destination || args.sql) return toolText(id, { ok: false, error_code: 'forbidden_field' });
      const result = await db.status(args.run_id || null);
      return { status: 200, body: rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }) };
    }
    if (name === 'publish_deal') {
      const gate = dealPreflight(args);
      if (!gate.ok) return toolText(id, gate);
      if (session.via === 'key') {
        const need = dealWriteScope(args.kind);
        if (!need || !session.scope.includes(need) || !session.keyId) return denied(id, auth);
      } else if (!session.scope.includes('research.publish')) {
        return denied(id, auth, 'research.publish');
      }
      const actor = session.via === 'key'
        ? { client: session.client, keyId: session.keyId }
        : { client: 'oauth', keyId: null };
      const result = await db.publishDeal(args, actor);
      if (result && result.error_code === 'insufficient_scope') return denied(id, auth);
      return toolText(id, result);
    }
    if (name === 'deal_status') {
      if (args.owner_id || args.destination || args.sql || args.price || args.quote) {
        return toolText(id, { ok: false, error_code: 'forbidden_field' });
      }
      const external = typeof args.external_key === 'string' && args.external_key.trim() ? args.external_key.trim() : null;
      if (external && !KEY.test(external)) return toolText(id, { ok: false, error_code: 'invalid_payload' });
      if (session.via === 'key') {
        const kinds = readableDealKinds(session.scope);
        if (!kinds.length) return denied(id, auth);
        if (!external && kinds.length < 3) {
          const result = await db.dealCounts(kinds);
          return { status: 200, body: rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }) };
        }
        const result = await db.dealStatus(external);
        if (external && result && result.found && result.record && !kinds.includes(result.record.kind)) return denied(id, auth);
        return { status: 200, body: rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }) };
      }
      if (!session.scope.includes('research.status.read')) return denied(id, auth);
      const result = await db.dealStatus(external);
      return { status: 200, body: rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }) };
    }
    return { status: 200, body: rpcError(id, -32601, 'unknown tool') };
  }
  return { status: 200, body: rpcError(id, -32601, 'unknown method') };
}
