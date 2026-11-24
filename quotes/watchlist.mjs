import { DEFAULT_SYMBOLS, MAX_SYMBOLS, normalizeSymbol } from './symbols.mjs';

export function currentWatchlist(stored) {
  const symbols = [];
  const seen = new Set();
  for (const raw of stored || []) {
    const symbol = normalizeSymbol(raw);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    if (symbols.length >= MAX_SYMBOLS) break;
    symbols.push(symbol);
  }
  return symbols.length ? symbols : DEFAULT_SYMBOLS.slice();
}

export function nextWatchlist(stored, action) {
  const base = currentWatchlist(stored);
  const kind = action && action.type;
  if (kind === 'remove') {
    const symbol = normalizeSymbol(action.symbol);
    if (!symbol || !base.includes(symbol)) return { ok: false, error: 'That symbol is not on the list.', symbols: base };
    if (base.length === 1) return { ok: false, error: 'Keep at least one symbol.', symbols: base };
    return { ok: true, symbols: base.filter((item) => item !== symbol) };
  }
  if (kind === 'up' || kind === 'down') {
    const symbol = normalizeSymbol(action.symbol);
    const index = base.indexOf(symbol);
    const next = kind === 'up' ? index - 1 : index + 1;
    if (index < 0 || next < 0 || next >= base.length) return { ok: true, symbols: base.slice() };
    const symbols = base.slice();
    const swapped = symbols[index];
    symbols[index] = symbols[next];
    symbols[next] = swapped;
    return { ok: true, symbols };
  }
  if (kind === 'add') {
    const symbol = normalizeSymbol(action.symbol);
    if (!symbol) return { ok: false, error: 'Enter a ticker like AMD or BRK.B.', symbols: base };
    if (base.includes(symbol)) return { ok: false, error: symbol + ' is already on the list.', symbols: base };
    if (base.length >= MAX_SYMBOLS) return { ok: false, error: 'The list holds ' + MAX_SYMBOLS + ' symbols.', symbols: base };
    return { ok: true, symbols: base.concat(symbol), added: symbol };
  }
  return { ok: false, error: 'That edit is not available.', symbols: base };
}

export function holdingRows(symbols, ownerId) {
  return symbols.map((symbol, sort_order) => ({
    owner_id: ownerId,
    bucket: 'holding',
    symbol,
    sort_order,
    source_note: 'Edited on the Markets page.'
  }));
}

export function acceptedQuote(payload, symbol) {
  const row = ((payload && payload.quotes) || []).find((quote) => quote && quote.symbol === symbol);
  return !!(row && !row.error && typeof row.price === 'number' && Number.isFinite(row.price) && row.price > 0);
}

export function saveRefusal(error) {
  if (!error) return '';
  const code = String(error.code || '');
  const status = Number(error.status || error.statusCode || 0);
  const msg = String(error.message || error.details || '');
  if (
    code === '42501' || code === 'PGRST301' || code === '401' || code === '403' ||
    status === 401 || status === 403 ||
    /permission denied|not authorized|row-level security|insufficient privilege|jwt/i.test(code + ' ' + msg)
  ) return "Saving isn't enabled yet";
  return 'The watchlist could not be saved.';
}

function inFilter(symbols) {
  return '(' + symbols.map((symbol) => '"' + symbol + '"').join(',') + ')';
}

// Upsert first. A missing grant fails here and does not delete anything.
export async function writeWatchlist(client, symbols, ownerId) {
  const rows = holdingRows(symbols, ownerId);
  const up = await client.from('watchlist').upsert(rows, { onConflict: 'owner_id,bucket,symbol' });
  if (up.error) return { ok: false, wrote: false, message: saveRefusal(up.error) };
  const extra = await client.from('watchlist').delete().eq('bucket', 'holding').not('symbol', 'in', inFilter(symbols));
  if (extra.error) return { ok: false, wrote: true, message: saveRefusal(extra.error) };
  const watches = await client.from('watchlist').delete().eq('bucket', 'watch');
  if (watches.error) return { ok: false, wrote: true, message: saveRefusal(watches.error) };
  return { ok: true, wrote: true, message: '' };
}
