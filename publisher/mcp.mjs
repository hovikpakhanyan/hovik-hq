import { preflight } from './validate.mjs';
import { dealPreflight } from './deals.mjs';

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
    description: 'Create or update one listing, pipeline, or escrow record for the fixed HQ owner. external_key is the stable id. record_id is this publication. Amounts are integer cents from the source record, not market quotes. Owner, SQL, secrets, and quote fields are rejected.',
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
    description: 'Read deal publication counts, or one record by external_key. No secrets and no note body.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { external_key: { type: 'string' } }
    }
  }
];

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function handleMcp({ auth, db, body, authorization }) {
  const header = String(authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = token ? await auth.introspect(token) : null;
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
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (message.method === 'tools/call') {
    const name = message.params && message.params.name;
    const args = (message.params && message.params.arguments) || {};
    if (name === 'publish_stock_research') {
      if (!session.scope.includes('research.publish')) {
        return {
          status: 403,
          headers: { 'www-authenticate': auth.challenge('insufficient_scope', 'research.publish'), 'cache-control': 'no-store' },
          body: rpcError(id, -32001, 'insufficient_scope')
        };
      }
      const gate = preflight(args);
      if (!gate.ok) return { status: 200, body: rpcResult(id, { isError: true, content: [{ type: 'text', text: JSON.stringify(gate) }] }) };
      const result = await db.publish(args);
      return { status: 200, body: rpcResult(id, { isError: !result.ok, content: [{ type: 'text', text: JSON.stringify(result) }] }) };
    }
    if (name === 'research_status') {
      if (!session.scope.includes('research.status.read')) {
        return { status: 403, body: rpcError(id, -32001, 'insufficient_scope') };
      }
      if (args.owner_id || args.destination || args.sql) {
        return { status: 200, body: rpcResult(id, { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error_code: 'forbidden_field' }) }] }) };
      }
      const result = await db.status(args.run_id || null);
      return { status: 200, body: rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }) };
    }
    if (name === 'publish_deal') {
      if (!session.scope.includes('research.publish')) {
        return {
          status: 403,
          headers: { 'www-authenticate': auth.challenge('insufficient_scope', 'research.publish'), 'cache-control': 'no-store' },
          body: rpcError(id, -32001, 'insufficient_scope')
        };
      }
      const gate = dealPreflight(args);
      if (!gate.ok) return { status: 200, body: rpcResult(id, { isError: true, content: [{ type: 'text', text: JSON.stringify(gate) }] }) };
      const result = await db.publishDeal(args);
      return { status: 200, body: rpcResult(id, { isError: !result.ok, content: [{ type: 'text', text: JSON.stringify(result) }] }) };
    }
    if (name === 'deal_status') {
      if (!session.scope.includes('research.status.read')) {
        return { status: 403, body: rpcError(id, -32001, 'insufficient_scope') };
      }
      if (args.owner_id || args.destination || args.sql || args.price || args.quote) {
        return { status: 200, body: rpcResult(id, { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error_code: 'forbidden_field' }) }] }) };
      }
      const result = await db.dealStatus(args.external_key || null);
      return { status: 200, body: rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }) };
    }
    return { status: 200, body: rpcError(id, -32601, 'unknown tool') };
  }
  return { status: 200, body: rpcError(id, -32601, 'unknown method') };
}
