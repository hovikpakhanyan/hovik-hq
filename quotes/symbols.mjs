// Symbol rules for the live watchlist. Letters, digits, dot, and dash. At most 10 characters.
export const MAX_SYMBOLS = 15;
export const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

// The markets page already treats this name as research, not a priced holding.
export const UNPRICED = new Set(['SPCX']);

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

// Published Supabase rows (holding, then watch) replace the in-page default.
// Candidates stay out of the tracker. SPCX stays on screen as unpriced.
export function trackerSymbols({ research, tracked } = {}) {
  const state = research || {};
  const published = [].concat(state.holdings || [], state.watch || []);
  const hasPublished = published.some((row) => normalizeSymbol(rowSymbol(row)));
  const source = hasPublished ? published : (tracked || []);
  const quotes = [];
  const unpriced = [];
  const seen = new Set();
  let truncated = 0;
  for (const row of source) {
    const symbol = normalizeSymbol(rowSymbol(row));
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    if (quotes.length + unpriced.length >= MAX_SYMBOLS) {
      truncated += 1;
      continue;
    }
    if (UNPRICED.has(symbol)) unpriced.push(symbol);
    else quotes.push(symbol);
  }
  return { quotes, unpriced, truncated, source: hasPublished ? 'watchlist' : 'default' };
}
