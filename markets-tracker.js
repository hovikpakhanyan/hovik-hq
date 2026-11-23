import { POLL_MS } from './quotes/cache.mjs';
import { formatChange, formatPacific, formatPrice } from './quotes/format.mjs';
import { statusLabel } from './quotes/market.mjs';
import { trackerSymbols } from './quotes/symbols.mjs';

const QUOTES_URL = '/.netlify/functions/quotes';

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function boards() {
  return Array.from(document.querySelectorAll('[data-live-board]'));
}

function listFromPage() {
  const api = window.HQMarkets;
  if (!api) return { quotes: [], unpriced: [], truncated: 0, source: 'default' };
  return trackerSymbols({
    research: typeof api.research === 'function' ? api.research() : null,
    tracked: typeof api.tracked === 'function' ? api.tracked() : []
  });
}

function onScreen() {
  if (document.hidden) return false;
  const app = document.getElementById('app');
  if (!app || !app.classList.contains('on')) return false;
  const page = document.getElementById('page-markets');
  if (page && !page.hidden) return true;
  const win = document.querySelector('.hq-win[data-module="markets"]');
  if (win && !win.hidden) return true;
  const pop = document.getElementById('module-pop');
  const panel = document.getElementById('markets-panel');
  if (pop && !pop.hidden && panel && pop.contains(panel)) return true;
  if (!panel || panel.closest('.hq-win') || panel.closest('#module-host')) return false;
  const work = panel.closest('.work');
  if (!work) return false;
  return getComputedStyle(work).display !== 'none';
}

function sparkPath(points) {
  const nums = points.filter((point) => typeof point === 'number' && Number.isFinite(point));
  if (nums.length < 2) return '';
  const min = Math.min.apply(null, nums);
  const max = Math.max.apply(null, nums);
  const span = max - min || 1;
  return nums.map((point, i) => {
    const x = (i / (nums.length - 1)) * 72;
    const y = 26 - ((point - min) / span) * 24;
    return (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
  }).join(' ');
}

function rowHtml(quote, market) {
  if (!quote || quote.error) {
    return '<article class="live-row is-error"><div class="live-copy"><strong class="live-sym">' + esc(quote && quote.symbol) +
      '</strong><p class="live-error">Quote unavailable</p></div></article>';
  }
  const direction = quote.change > 0 ? 'up' : quote.change < 0 ? 'down' : 'flat';
  const change = quote.changeError ? esc(quote.changeError) : esc(formatChange(quote.change, quote.changePct));
  const when = formatPacific(quote.asOf);
  const bits = [statusLabel(market), when, quote.delay || 'delay not stated'].filter(Boolean);
  const spark = Array.isArray(quote.spark) && quote.spark.length > 1
    ? '<svg class="live-spark" viewBox="0 0 72 28" aria-hidden="true"><path d="' + sparkPath(quote.spark) + '"></path></svg>'
    : '';
  return '<article class="live-row ' + direction + '"><div class="live-copy"><strong class="live-sym">' + esc(quote.symbol) +
    '</strong><span class="live-px">' + esc(formatPrice(quote.price, quote.currency)) + '</span><span class="live-chg">' +
    change + '</span><span class="live-meta">' + esc(bits.join(' · ')) + '</span></div>' + spark + '</article>';
}

function unpricedHtml(symbol) {
  return '<article class="live-row"><div class="live-copy"><strong class="live-sym">' + esc(symbol) +
    '</strong><p class="live-error">Not a priced holding. No quote is shown.</p></div></article>';
}

function paint(html, statusText) {
  boards().forEach((board) => {
    const status = board.querySelector('[data-live-status]');
    const rows = board.querySelector('[data-live-rows]');
    if (status) status.textContent = statusText;
    if (rows) rows.innerHTML = html;
  });
}

function renderPayload(data, list) {
  const market = data && data.market ? data.market : { status: 'closed' };
  const quotes = new Map(((data && data.quotes) || []).map((quote) => [quote.symbol, quote]));
  const parts = list.quotes.map((symbol) => rowHtml(quotes.get(symbol) || { symbol, error: 'Quote unavailable' }, market));
  list.unpriced.forEach((symbol) => parts.push(unpricedHtml(symbol)));
  if (list.truncated) parts.push('<p class="live-note">Showing the first symbols only. ' + list.truncated + ' more were left off this request.</p>');
  const note = data && data.ok ? '' : '';
  paint(parts.join('') + note, statusLabel(market));
}

let timer = 0;
let busy = false;
let again = false;
let currentKey = '';
let wasOn = false;
let lastFetch = 0;

function stop() {
  if (timer) clearTimeout(timer);
  timer = 0;
}

function arm(ms) {
  stop();
  if (!ms || ms < 0) return;
  timer = setTimeout(() => { timer = 0; refresh(); }, ms);
}

async function load(list) {
  if (!list.quotes.length) {
    const parts = list.unpriced.map(unpricedHtml);
    const empty = parts.length ? parts.join('') : '<p class="live-note">No symbols on the watchlist.</p>';
    paint(empty, list.unpriced.length ? 'Not priced' : 'No symbols');
    arm(0);
    return;
  }
  const response = await fetch(QUOTES_URL + '?symbols=' + encodeURIComponent(list.quotes.join(',')), { cache: 'no-store' });
  let data = null;
  try { data = await response.json(); } catch (e) { data = null; }
  if (!response.ok || !data || data.ok === false) {
    const message = data && data.error ? data.error : 'Quotes could not be loaded';
    const extra = list.unpriced.map(unpricedHtml).join('');
    paint('<p class="live-error">' + esc(message) + '</p>' + extra, message);
    arm(POLL_MS);
    return;
  }
  renderPayload(data, list);
  arm(POLL_MS);
}

async function refresh() {
  const visible = onScreen();
  if (!visible) {
    if (!document.hidden) wasOn = false;
    stop();
    return;
  }
  const list = listFromPage();
  const key = list.quotes.join(',') + '|' + list.unpriced.join(',');
  const opened = !wasOn;
  const keyChanged = key !== currentKey;
  wasOn = true;
  const elapsed = lastFetch ? Date.now() - lastFetch : POLL_MS;
  if (!opened && !keyChanged && elapsed < POLL_MS) {
    if (!timer) arm(POLL_MS - elapsed);
    return;
  }
  if (busy) { again = true; return; }
  busy = true;
  currentKey = key;
  lastFetch = Date.now();
  try { await load(list); }
  catch (e) {
    paint('<p class="live-error">Quotes could not be loaded</p>', 'Quotes could not be loaded');
    arm(POLL_MS);
  }
  busy = false;
  if (again) {
    again = false;
    const next = listFromPage();
    const nextKey = next.quotes.join(',') + '|' + next.unpriced.join(',');
    if (nextKey !== currentKey) refresh();
  }
}

function boot() {
  const watch = new MutationObserver(() => { refresh(); });
  const app = document.getElementById('app');
  const page = document.getElementById('page-markets');
  const pop = document.getElementById('module-pop');
  const workspace = document.getElementById('workspace');
  if (app) watch.observe(app, { attributes: true, attributeFilter: ['class'] });
  if (page) watch.observe(page, { attributes: true, attributeFilter: ['hidden'] });
  if (pop) watch.observe(pop, { attributes: true, attributeFilter: ['hidden'] });
  if (workspace) watch.observe(workspace, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stop(); return; }
    refresh();
  });
  window.HQTracker = { sync: refresh };
  refresh();
}

boot();
