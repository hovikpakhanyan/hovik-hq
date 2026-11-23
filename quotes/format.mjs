export function formatPrice(value, currency) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  const digits = n >= 1 ? 2 : 4;
  const text = n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (!currency || currency === 'USD') return `$${text}`;
  return `${currency} ${text}`;
}

export function formatChange(change, changePct) {
  if (!Number.isFinite(change) || !Number.isFinite(changePct)) return '';
  const money = Math.abs(change).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = Math.abs(changePct).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = change > 0 ? '+' : change < 0 ? '−' : '';
  const pctSign = changePct > 0 ? '+' : changePct < 0 ? '−' : '';
  return `${sign}$${money} · ${pctSign}${pct}%`;
}

export function formatPacific(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const text = date.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
  return `${text} PT`;
}

export function delayLabel(seconds) {
  if (seconds == null || seconds === '') return 'delay not stated';
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return 'delay not stated';
  if (n === 0) return 'real-time';
  const mins = Math.round(n / 60);
  if (mins === 15) return '15-min delayed';
  if (mins <= 0) return 'real-time';
  if (mins === 1) return '1-min delayed';
  return `${mins}-min delayed`;
}
