// Matches public.watchlist.symbol. Letters, digits, and a dot. At most 10 characters.
export const MAX_SYMBOLS = 25;
export const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
export const DEFAULT_SYMBOLS = ['AMD', 'GOOGL', 'NVDA', 'PNFP', 'QQQ', 'TQQQ', 'URA'];

export function normalizeSymbol(raw) {
  const text = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!SYMBOL_RE.test(text)) return '';
  return text;
}

export function validateSymbols(list) {
  const symbols = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of list || []) {
    const symbol = normalizeSymbol(raw);
    if (!symbol) {
      const label = String(raw == null ? '' : raw).trim().slice(0, 32);
      rejected.push(label || '(blank)');
      continue;
    }
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    if (symbols.length >= MAX_SYMBOLS) {
      rejected.push(symbol);
      continue;
    }
    symbols.push(symbol);
  }
  return { symbols, rejected };
}

function rowSymbol(row) {
  if (typeof row === 'string') return row;
  return row && row.symbol;
}

// Published holding and watch rows replace the seven-name default.
// Candidates stay off the tracker.
export function trackerSymbols({ research } = {}) {
  const state = research || {};
  const published = [].concat(state.holdings || [], state.watch || []);
  const hasPublished = published.some((row) => normalizeSymbol(rowSymbol(row)));
  const source = hasPublished ? published : DEFAULT_SYMBOLS;
  const quotes = [];
  const seen = new Set();
  let truncated = 0;
  for (const row of source) {
    const symbol = normalizeSymbol(rowSymbol(row));
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    if (quotes.length >= MAX_SYMBOLS) {
      truncated += 1;
      continue;
    }
    quotes.push(symbol);
  }
  return { quotes, truncated, source: hasPublished ? 'watchlist' : 'default' };
}
