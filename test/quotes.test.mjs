import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { priceChange } from '../quotes/change.mjs';
import { cacheControl, cacheSeconds, pollIntervalMs } from '../quotes/cache.mjs';
import { delayLabel, formatChange, formatPacific, formatPrice } from '../quotes/format.mjs';
import { resolveMarketStatus, statusFromClock, statusLabel } from '../quotes/market.mjs';
import { trackerSymbols, validateSymbols } from '../quotes/symbols.mjs';
import { mapSparkPayload, sparklineCloses } from '../quotes/yahoo.mjs';
import { createQuotesHandler } from '../netlify/functions/quotes.mjs';

const tracked = [
  { symbol: 'amd' },
  { symbol: 'GOOGL' },
  { symbol: 'SPCX' },
  { symbol: 'QQQ' }
];

function spark(symbol, extra = {}) {
  return {
    symbol,
    response: [{
      meta: {
        currency: 'USD',
        symbol,
        regularMarketPrice: 100,
        previousClose: 80,
        regularMarketTime: 1_763_996_400,
        currentTradingPeriod: extra.periods || null,
        exchangeDataDelayedBy: extra.delay,
        ...extra.meta
      },
      timestamp: extra.timestamp || [100, 200],
      indicators: { quote: [{ close: extra.closes || [80, 90, 100] }] }
    }]
  };
}

test('symbols accept letters, digits, dot, and dash, and cap the list', () => {
  const parsed = validateSymbols(['amd', 'BRK.B', 'BRK-B', 'QQQ', 'bad symbol', '123', '', 'AMD', 'A'.repeat(11)]);
  assert.deepEqual(parsed.symbols, ['AMD', 'BRK.B', 'BRK-B', 'QQQ']);
  assert.deepEqual(parsed.rejected, ['bad symbol', '123', '(blank)', 'A'.repeat(11)]);
  const many = validateSymbols(Array.from({ length: 16 }, (_n, i) => 'S' + String(i + 1).padStart(2, '0')));
  assert.equal(many.symbols.length, 15);
  assert.equal(many.rejected.length, 1);
});

test('the tracker follows a published watchlist and otherwise the existing default', () => {
  const fallback = trackerSymbols({ research: { holdings: [], watch: [] }, tracked });
  assert.deepEqual(fallback.quotes, ['AMD', 'GOOGL', 'QQQ']);
  assert.deepEqual(fallback.unpriced, ['SPCX']);
  assert.equal(fallback.source, 'default');
  const published = trackerSymbols({
    research: {
      holdings: [{ symbol: 'nvda' }, { symbol: 'AMD' }],
      watch: [{ symbol: 'ura' }, { symbol: 'SPCX' }, { symbol: 'nope symbol' }],
      candidates: [{ symbol: 'RGTI' }]
    },
    tracked
  });
  assert.deepEqual(published.quotes, ['NVDA', 'AMD', 'URA']);
  assert.deepEqual(published.unpriced, ['SPCX']);
  assert.equal(published.source, 'watchlist');
});

test('day change is real math, and a missing quote is not a zero', () => {
  const up = priceChange(100, 80);
  assert.equal(up.ok, true);
  assert.equal(up.change, 20);
  assert.equal(up.changePct, 25);
  const flat = priceChange(100, 100);
  assert.equal(flat.ok, true);
  assert.equal(flat.change, 0);
  assert.equal(flat.changePct, 0);
  for (const bad of [priceChange(null, 80), priceChange(0, 80), priceChange(undefined, 80), priceChange('nope', 80)]) {
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'Quote unavailable');
    assert.equal(bad.change, undefined);
  }
  const noPrev = priceChange(100, 0);
  assert.equal(noPrev.ok, false);
  assert.equal(noPrev.error, 'Change unavailable');
  assert.equal(priceChange(100, null).change, undefined);
});

test('market status follows New York hours, weekends, holidays, and early closes', () => {
  assert.equal(statusFromClock(new Date('2026-11-24T14:29:00Z')).status, 'pre-market');
  assert.equal(statusFromClock(new Date('2026-11-24T14:30:00Z')).status, 'open');
  assert.equal(statusFromClock(new Date('2026-11-24T20:59:00Z')).status, 'open');
  assert.equal(statusFromClock(new Date('2026-11-24T21:00:00Z')).status, 'after-hours');
  assert.equal(statusFromClock(new Date('2026-11-25T00:59:00Z')).status, 'after-hours');
  assert.equal(statusFromClock(new Date('2026-11-25T01:00:00Z')).status, 'closed');
  const weekend = statusFromClock(new Date('2026-11-28T15:00:00Z'));
  assert.equal(weekend.status, 'closed');
  assert.equal(weekend.reason, 'weekend');
  const holiday = statusFromClock(new Date('2026-11-26T15:00:00Z'));
  assert.equal(holiday.status, 'closed');
  assert.equal(holiday.reason, 'holiday');
  assert.equal(holiday.holiday, 'Thanksgiving');
  assert.equal(statusFromClock(new Date('2026-12-24T17:30:00Z')).status, 'open');
  const early = statusFromClock(new Date('2026-12-24T18:00:00Z'));
  assert.equal(early.status, 'after-hours');
  assert.equal(early.earlyClose, 'Christmas Eve');
  assert.equal(statusFromClock(new Date('2026-12-24T22:00:00Z')).status, 'closed');
  assert.match(statusLabel(holiday), /Closed · Thanksgiving/);
});

test('a source session can correct the clock, except on a known holiday', () => {
  const open = new Date('2026-11-24T15:00:00Z');
  const t = Math.floor(open.getTime() / 1000);
  const away = resolveMarketStatus(open, { regular: { start: t + 10_000, end: t + 20_000 } });
  assert.equal(away.status, 'closed');
  assert.equal(away.reason, 'source');
  const inside = resolveMarketStatus(open, {
    pre: { start: t - 20_000, end: t - 100 },
    regular: { start: t - 100, end: t + 100 },
    post: { start: t + 100, end: t + 200 }
  });
  assert.equal(inside.status, 'open');
  assert.equal(inside.reason, 'hours');
  const holiday = resolveMarketStatus(new Date('2026-11-26T15:00:00Z'), {
    regular: { start: 0, end: 2_000_000_000 }
  });
  assert.equal(holiday.status, 'closed');
  assert.equal(holiday.reason, 'holiday');
});

test('quotes refresh hourly in every session, and the CDN keeps the response for an hour', () => {
  for (const status of ['open', 'pre-market', 'after-hours', 'closed']) {
    assert.equal(pollIntervalMs(status), 60 * 60 * 1000);
    assert.equal(cacheSeconds(status), 3600);
    assert.match(cacheControl(status)['netlify-cdn-cache-control'], /s-maxage=3600/);
    assert.match(cacheControl(status)['netlify-cdn-cache-control'], /stale-while-revalidate=300/);
  }
});

test('sparkline mapping omits a failed symbol instead of inventing a price', () => {
  const now = new Date('2026-11-24T15:00:00Z');
  const t = Math.floor(now.getTime() / 1000);
  const periods = { regular: { start: t - 100, end: t + 100 } };
  const mapped = mapSparkPayload({
    spark: {
      result: [
        spark('AMD', { periods, closes: [1, null, 2, 3] }),
        spark('SPAXX', { meta: { regularMarketPrice: 1, previousClose: null, currentTradingPeriod: periods } })
      ]
    }
  }, ['AMD', 'SPAXX', 'NOPE'], now);
  assert.equal(mapped.market.status, 'open');
  assert.equal(mapped.quotes[0].price, 100);
  assert.equal(mapped.quotes[0].change, 20);
  assert.deepEqual(mapped.quotes[0].spark, [1, 2, 3]);
  assert.equal(mapped.quotes[0].error, '');
  assert.equal(mapped.quotes[1].price, 1);
  assert.equal(mapped.quotes[1].change, null);
  assert.equal(mapped.quotes[1].changeError, 'Change unavailable');
  assert.equal(mapped.quotes[2].error, 'Quote unavailable');
  assert.equal(mapped.quotes[2].price, undefined);
  assert.equal(sparklineCloses([null, 1]), null);
  assert.equal(sparklineCloses([0, 0]), null);
});

test('the quotes function reports a missing source, rejects bad symbols, and caches by session', async () => {
  let calls = 0;
  const blocked = createQuotesHandler({ env: { QUOTE_SOURCE: 'alpaca' }, fetchImpl: async () => { calls += 1; throw new Error('called'); } });
  const denied = await blocked(new Request('https://hq.example/.netlify/functions/quotes?symbols=AMD'));
  assert.equal(denied.status, 503);
  assert.equal((await denied.json()).error, 'quote source not configured');
  assert.equal(calls, 0);

  const now = new Date('2026-11-24T15:00:00Z');
  const t = Math.floor(now.getTime() / 1000);
  const seen = [];
  const handler = createQuotesHandler({
    env: {},
    now: () => now,
    fetchImpl: async (url) => {
      seen.push(String(url));
      return Response.json({
        spark: {
          result: [spark('AMD', {
            periods: { regular: { start: t - 60, end: t + 60 } },
            meta: { regularMarketPrice: 0, previousClose: 10 }
          })]
        }
      });
    }
  });
  const bad = await handler(new Request('https://hq.example/.netlify/functions/quotes?symbols=not a symbol'));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'No valid symbols');
  const res = await handler(new Request('https://hq.example/.netlify/functions/quotes?symbols=AMD,GONE,bad%20symbol'));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('netlify-cdn-cache-control').includes('s-maxage=3600'), true);
  assert.equal(res.headers.get('netlify-cdn-cache-control').includes('stale-while-revalidate=300'), true);
  assert.equal(res.headers.get('netlify-cdn-cache-control').includes('durable'), true);
  assert.equal(body.quotes[0].error, 'Quote unavailable');
  assert.equal(body.quotes[0].price, undefined);
  assert.equal(body.quotes[1].symbol, 'GONE');
  assert.equal(body.quotes[1].error, 'Quote unavailable');
  assert.equal(body.quotes[1].price, undefined);
  assert.deepEqual(body.rejected, ['bad symbol']);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /symbols=AMD(%2C|,)GONE/);
  assert.equal(seen[0].includes('bad'), false);

  const down = createQuotesHandler({
    env: {},
    fetchImpl: async () => { throw new Error('network'); }
  });
  const failed = await down(new Request('https://hq.example/.netlify/functions/quotes?symbols=AMD'));
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).error, 'Quotes could not be loaded');
});

test('prices format in Pacific time and the delay is labeled only when the source states it', () => {
  assert.equal(formatPrice(453.4, 'USD'), '$453.40');
  assert.equal(formatPrice(0, 'USD'), '');
  assert.equal(formatChange(1.2, 0.98), '+$1.20 · +0.98%');
  assert.equal(formatChange(-1.2, -0.5), '−$1.20 · −0.50%');
  assert.equal(formatChange(0, 0), '$0.00 · 0.00%');
  assert.equal(formatPacific('2026-11-23T21:00:00Z'), 'Nov 23, 1:00 PM PT');
  assert.equal(delayLabel(undefined), 'delay not stated');
  assert.equal(delayLabel(0), 'real-time');
  assert.equal(delayLabel(900), '15-min delayed');
  const headers = cacheControl('after-hours');
  assert.match(headers['netlify-cdn-cache-control'], /s-maxage=3600/);
});

test('the markets page keeps the live board first and does not bake in a price', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const panel = html.slice(html.indexOf('id="markets-panel"'), html.indexOf('id="markets-rows"'));
  assert.match(panel, /data-live-board/);
  const pageStart = html.indexOf('id="page-markets"');
  const hero = html.indexOf('class="markets-hero"', pageStart);
  assert.match(html.slice(pageStart, hero), /data-live-board/);
  assert.equal(html.includes('markets-tracker.js'), true);
  assert.equal(/\$\d{2,}/.test(html.slice(pageStart, pageStart + 8000)), false);
});
