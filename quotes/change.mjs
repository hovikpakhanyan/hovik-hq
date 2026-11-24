function finiteNumber(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// A missing quote is an error. A real unchanged price is a zero change.
export function priceChange(price, previousClose) {
  const last = finiteNumber(price);
  const prev = finiteNumber(previousClose);
  if (last == null || last <= 0) return { ok: false, error: 'Quote unavailable' };
  if (prev == null || prev <= 0) return { ok: false, error: 'Change unavailable' };
  const change = last - prev;
  return { ok: true, price: last, previousClose: prev, change, changePct: (change / prev) * 100 };
}
