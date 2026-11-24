import { priceChange } from './change.mjs';
import { delayLabel } from './format.mjs';
import { resolveMarketStatus } from './market.mjs';

const SPARK_POINTS = 32;

export function buildSparkUrl(symbols) {
  const url = new URL('https://query1.finance.yahoo.com/v7/finance/spark');
  url.searchParams.set('symbols', symbols.join(','));
  url.searchParams.set('range', '1d');
  url.searchParams.set('interval', '5m');
  url.searchParams.set('includePrePost', 'true');
  return url;
}

function finiteOrNull(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function sparklineCloses(closes) {
  const points = (closes || []).filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
  if (points.length < 2) return null;
  if (points.length <= SPARK_POINTS) return points;
  const last = points.length - 1;
  const out = [];
  for (let i = 0; i < SPARK_POINTS; i++) out.push(points[Math.round((i * last) / (SPARK_POINTS - 1))]);
  return out;
}

function latestTimestamp(chart, meta) {
  const stamps = (chart && chart.timestamp) || [];
  let best = finiteOrNull(meta && meta.regularMarketTime);
  for (const stamp of stamps) {
    const n = finiteOrNull(stamp);
    if (n != null && (best == null || n > best)) best = n;
  }
  return best == null ? '' : new Date(best * 1000).toISOString();
}

function choosePrice(meta, status) {
  const regular = finiteOrNull(meta && meta.regularMarketPrice);
  const full = finiteOrNull(meta && meta.fulldayPrice);
  const extended = status === 'pre-market' || status === 'after-hours';
  const picked = extended ? (full != null && full > 0 ? full : regular) : (regular != null && regular > 0 ? regular : full);
  return picked != null && picked > 0 ? picked : null;
}

function mapOne(row, symbol, status) {
  const chart = row && Array.isArray(row.response) ? row.response[0] : null;
  const meta = chart && chart.meta;
  const price = choosePrice(meta, status);
  if (price == null) return { symbol, error: 'Quote unavailable' };
  const math = priceChange(price, meta.previousClose);
  const closes = chart.indicators && chart.indicators.quote && chart.indicators.quote[0] && chart.indicators.quote[0].close;
  return {
    symbol,
    price: math.ok ? math.price : price,
    previousClose: math.ok ? math.previousClose : null,
    change: math.ok ? math.change : null,
    changePct: math.ok ? math.changePct : null,
    changeError: math.ok ? '' : math.error,
    currency: meta.currency || '',
    asOf: latestTimestamp(chart, meta),
    delay: delayLabel(meta.exchangeDataDelayedBy),
    spark: sparklineCloses(closes),
    error: ''
  };
}

export function mapSparkPayload(payload, requested, now) {
  const rows = (payload && payload.spark && payload.spark.result) || [];
  const bySymbol = new Map();
  let periods = null;
  for (const row of rows) {
    if (row && row.symbol) bySymbol.set(String(row.symbol).toUpperCase(), row);
    const meta = row && row.response && row.response[0] && row.response[0].meta;
    if (!periods && meta && meta.currentTradingPeriod) periods = meta.currentTradingPeriod;
  }
  const market = resolveMarketStatus(now, periods);
  const quotes = (requested || []).map((symbol) => mapOne(bySymbol.get(symbol), symbol, market.status));
  return { market, quotes };
}
