import { POLL_MS } from './quotes/cache.mjs';
import { formatChange, formatPacific, formatPrice } from './quotes/format.mjs';
import { statusLabel } from './quotes/market.mjs';
import { trackerSymbols } from './quotes/symbols.mjs';
import { acceptedQuote, currentWatchlist, nextWatchlist, writeWatchlist } from './quotes/watchlist.mjs';

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

function storedSymbols() {
  const api = window.HQMarkets;
  const research = api && typeof api.research === 'function' ? api.research() : null;
  const state = research || {};
  return [].concat(state.holdings || [], state.watch || []).map((row) => row && row.symbol);
}

function listFromPage() {
  const stored = storedSymbols().filter(Boolean);
  const research = stored.length ? { holdings: stored.map((symbol) => ({ symbol })), watch: [] } : { holdings: [], watch: [] };
  return trackerSymbols({ research });
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
  if (list.truncated) parts.push('<p class="live-note">Showing the first symbols only. ' + list.truncated + ' more were left off this request.</p>');
  paint(parts.join(''), statusLabel(market));
}

function editNote(text) {
  boards().forEach((board) => {
    const note = board.querySelector('[data-live-edit-note]');
    if (note) note.textContent = text || '';
  });
}

function renderEditor() {
  const symbols = currentWatchlist(storedSymbols());
  boards().forEach((board) => {
    const edit = board.querySelector('[data-live-edit]');
    if (!edit) return;
    edit.hidden = !owner;
    const host = edit.querySelector('[data-live-order]');
    if (!host) return;
    host.innerHTML = symbols.map((symbol, index) => (
      '<div class="live-edit-row"><strong>' + esc(symbol) + '</strong><div class="live-edit-actions">' +
      '<button type="button" class="text-btn" data-live-move="up" data-symbol="' + esc(symbol) + '"' + (index === 0 ? ' disabled' : '') + '>Up</button>' +
      '<button type="button" class="text-btn" data-live-move="down" data-symbol="' + esc(symbol) + '"' + (index === symbols.length - 1 ? ' disabled' : '') + '>Down</button>' +
      '<button type="button" class="text-btn" data-live-remove="' + esc(symbol) + '">Remove</button>' +
      '</div></div>'
    )).join('');
  });
}

let timer = 0;
let busy = false;
let again = false;
let saving = false;
let currentKey = '';
let wasOn = false;
let lastFetch = 0;
let owner = false;

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
    paint('<p class="live-note">No symbols on the watchlist.</p>', 'No symbols');
    arm(0);
    return;
  }
  const response = await fetch(QUOTES_URL + '?symbols=' + encodeURIComponent(list.quotes.join(',')), { cache: 'no-store' });
  let data = null;
  try { data = await response.json(); } catch (e) { data = null; }
  if (!response.ok || !data || data.ok === false) {
    const message = data && data.error ? data.error : 'Quotes could not be loaded';
    paint('<p class="live-error">' + esc(message) + '</p>', message);
    arm(POLL_MS);
    return;
  }
  renderPayload(data, list);
  arm(POLL_MS);
}

async function refresh() {
  renderEditor();
  const visible = onScreen();
  if (!visible) {
    if (!document.hidden) wasOn = false;
    stop();
    return;
  }
  const list = listFromPage();
  const key = list.quotes.join(',');
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
    const nextKey = listFromPage().quotes.join(',');
    if (nextKey !== currentKey) refresh();
  }
}

async function refreshOwner() {
  owner = false;
  try {
    const client = window.sb;
    if (!client) { renderEditor(); return; }
    const { data: { session } } = await client.auth.getSession();
    if (!session) { renderEditor(); return; }
    const { data, error } = await client.rpc('hq_is_bound_owner');
    owner = !error && data === true;
  } catch (e) {
    owner = false;
  }
  renderEditor();
}

async function commitEdit(action) {
  if (saving) return;
  const planned = nextWatchlist(storedSymbols(), action);
  if (!planned.ok) { editNote(planned.error); return; }
  if (planned.added) {
    editNote('Checking ' + planned.added + '…');
    let payload = null;
    try {
      const response = await fetch(QUOTES_URL + '?symbols=' + encodeURIComponent(planned.added), { cache: 'no-store' });
      payload = await response.json();
    } catch (e) {
      payload = null;
    }
    if (!acceptedQuote(payload, planned.added)) {
      editNote('Yahoo has no price for ' + planned.added + '.');
      return;
    }
  }
  const session = await window.sb.auth.getSession();
  const user = session && session.data && session.data.session && session.data.session.user;
  if (!user) { editNote("Saving isn't enabled yet"); return; }
  saving = true;
  editNote('Saving…');
  let result;
  try { result = await writeWatchlist(window.sb, planned.symbols, user.id); }
  catch (e) { result = { ok: false, wrote: false, message: 'The watchlist could not be saved.' }; }
  saving = false;
  if (!result.ok) {
    editNote(result.message);
    if (result.wrote && window.HQMarkets && window.HQMarkets.reload) await window.HQMarkets.reload();
    else renderEditor();
    return;
  }
  editNote('Saved.');
  boards().forEach((board) => {
    const input = board.querySelector('[data-live-input]');
    if (input) input.value = '';
  });
  if (window.HQMarkets && window.HQMarkets.reload) await window.HQMarkets.reload();
  else refresh();
}

function boot() {
  const watch = new MutationObserver((mutations) => {
    const internal = mutations.every((mutation) => {
      const node = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      return node && node.closest && node.closest('[data-live-board]');
    });
    if (!internal) refresh();
  });
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
  document.addEventListener('submit', (event) => {
    const form = event.target.closest && event.target.closest('[data-live-add]');
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector('[data-live-input]');
    commitEdit({ type: 'add', symbol: input ? input.value : '' });
  });
  document.addEventListener('click', (event) => {
    const move = event.target.closest && event.target.closest('[data-live-move]');
    if (move) {
      commitEdit({ type: move.getAttribute('data-live-move'), symbol: move.getAttribute('data-symbol') });
      return;
    }
    const remove = event.target.closest && event.target.closest('[data-live-remove]');
    if (remove) commitEdit({ type: 'remove', symbol: remove.getAttribute('data-live-remove') });
  });
  window.HQTracker = { sync: refresh };
  if (window.sb && window.sb.auth && window.sb.auth.onAuthStateChange) {
    window.sb.auth.onAuthStateChange(() => { refreshOwner(); });
  }
  refreshOwner();
  refresh();
}

boot();
