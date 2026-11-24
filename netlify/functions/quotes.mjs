import { cacheControl } from '../../quotes/cache.mjs';
import { validateSymbols } from '../../quotes/symbols.mjs';
import { buildSparkUrl, mapSparkPayload } from '../../quotes/yahoo.mjs';

// Yahoo's chart endpoint needs no key. Any other QUOTE_SOURCE is refused
// until that source is wired and its key is present.
const YAHOO = 'yahoo-chart';

function envGet(name, env) {
  if (env) return env[name] || '';
  if (typeof process !== 'undefined' && process.env && process.env[name]) return process.env[name];
  if (typeof Netlify !== 'undefined' && Netlify.env && typeof Netlify.env.get === 'function') {
    return Netlify.env.get(name) || '';
  }
  return '';
}

export function sourceReady(env) {
  const name = envGet('QUOTE_SOURCE', env) || YAHOO;
  if (name === YAHOO) return { ok: true, name };
  const keyName = envGet('QUOTE_API_KEY_NAME', env);
  const key = keyName ? envGet(keyName, env) : '';
  if (key) return { ok: true, name };
  return { ok: false, name };
}

function json(body, status, headers) {
  return Response.json(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers
    }
  });
}

export function createQuotesHandler({ env, fetchImpl, now } = {}) {
  const load = fetchImpl || fetch;
  return async function quotes(req) {
    const ready = sourceReady(env);
    if (!ready.ok) {
      return json({ ok: false, error: 'quote source not configured' }, 503, {
        'cache-control': 'no-store',
        'netlify-cdn-cache-control': 'no-store'
      });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json({ ok: false, error: 'Method not allowed' }, 405, { 'cache-control': 'no-store', allow: 'GET, HEAD' });
    }
    let symbols = [];
    let rejected = [];
    try {
      const url = new URL(req.url);
      const raw = (url.searchParams.get('symbols') || '').split(',');
      const parsed = validateSymbols(raw);
      symbols = parsed.symbols;
      rejected = parsed.rejected;
    } catch {
      return json({ ok: false, error: 'No valid symbols' }, 400, { 'cache-control': 'no-store' });
    }
    if (!symbols.length) {
      return json({ ok: false, error: 'No valid symbols', rejected }, 400, { 'cache-control': 'no-store' });
    }
    const clock = typeof now === 'function' ? now() : new Date();
    let payload;
    try {
      const upstream = await load(buildSparkUrl(symbols), {
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000)
      });
      if (!upstream.ok) throw new Error('upstream');
      payload = await upstream.json();
    } catch {
      return json({ ok: false, error: 'Quotes could not be loaded' }, 502, {
        'cache-control': 'public, max-age=0, must-revalidate',
        'netlify-cdn-cache-control': 'public, durable, s-maxage=30, stale-while-revalidate=15'
      });
    }
    if (payload && payload.spark && payload.spark.error) {
      return json({ ok: false, error: 'Quotes could not be loaded' }, 502, {
        'cache-control': 'no-store',
        'netlify-cdn-cache-control': 'public, durable, s-maxage=30'
      });
    }
    const mapped = mapSparkPayload(payload, symbols, clock);
    const headers = cacheControl();
    return json({
      ok: true,
      source: ready.name,
      market: mapped.market,
      quotes: mapped.quotes,
      rejected
    }, 200, {
      'cache-control': headers['cache-control'],
      'netlify-cdn-cache-control': headers['netlify-cdn-cache-control']
    });
  };
}

export default createQuotesHandler();
