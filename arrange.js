(function (root) {
  var PANELS = ['chat', 'tasks', 'markets', 'listings', 'agents'];
  var TITLES = { chat: 'Chat', tasks: 'Tasks', markets: 'Markets', listings: 'Listings', agents: 'Agents' };
  var DEFAULT_CENTER = 'chat';
  var STORAGE_KEY = 'hq.arrange.v1';

  function defaultState() {
    return {
      center: DEFAULT_CENTER,
      bar: PANELS.filter(function (id) { return id !== DEFAULT_CENTER; })
    };
  }

  function knownSet() {
    var known = Object.create(null);
    PANELS.forEach(function (id) { known[id] = true; });
    return known;
  }

  function normalize(saved) {
    var known = knownSet();
    var center = DEFAULT_CENTER;
    if (saved && typeof saved === 'object' && !Array.isArray(saved) && typeof saved.center === 'string' && known[saved.center]) {
      center = saved.center;
    }
    var bar = [];
    var seen = Object.create(null);
    seen[center] = true;
    var incoming = saved && typeof saved === 'object' && !Array.isArray(saved) && Array.isArray(saved.bar) ? saved.bar : [];
    incoming.forEach(function (id) {
      if (typeof id !== 'string' || !known[id] || seen[id]) return;
      seen[id] = true;
      bar.push(id);
    });
    PANELS.forEach(function (id) {
      if (!seen[id]) bar.push(id);
    });
    return { center: center, bar: bar };
  }

  function swap(state, id) {
    var current = normalize(state);
    if (typeof id !== 'string' || id === current.center) return current;
    var index = current.bar.indexOf(id);
    if (index < 0) return current;
    var bar = current.bar.slice();
    bar[index] = current.center;
    return { center: id, bar: bar };
  }

  function loadState(storage) {
    if (!storage || typeof storage.getItem !== 'function') return defaultState();
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      return normalize(JSON.parse(raw));
    } catch (e) {
      return defaultState();
    }
  }

  function saveState(storage, state) {
    var next = normalize(state);
    storage.setItem(STORAGE_KEY, JSON.stringify({ center: next.center, bar: next.bar.slice() }));
    return next;
  }

  root.HQArrange = {
    PANELS: PANELS.slice(),
    TITLES: { chat: 'Chat', tasks: 'Tasks', markets: 'Markets', listings: 'Listings', agents: 'Agents' },
    DEFAULT_CENTER: DEFAULT_CENTER,
    STORAGE_KEY: STORAGE_KEY,
    defaultState: defaultState,
    normalize: normalize,
    swap: swap,
    loadState: loadState,
    saveState: saveState
  };

  function boot() {
    var centerSlot = document.getElementById('center-slot');
    var bar = document.getElementById('side-bar');
    var centerHost = document.getElementById('center-host');
    var storage = null;
    try { storage = window.localStorage; } catch (e) { storage = null; }
    if (!centerSlot || !bar || !centerHost || !storage) return;
    var slots = Array.prototype.slice.call(bar.querySelectorAll('.bar-slot'));
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion.addEventListener) motion.addEventListener('change', function (e) { reduced = e.matches; });
    var state = loadState(storage);
    var scrollMemory = new WeakMap();

    function panelNode(id) {
      return document.querySelector('[data-panel="' + id + '"]');
    }
    function parked(node) {
      return !!(node && node.closest && node.closest('.hq-win'));
    }
    function eachBox(node, fn) {
      fn(node);
      var kids = node.querySelectorAll('*');
      for (var i = 0; i < kids.length; i++) fn(kids[i]);
    }
    function remember(node) {
      eachBox(node, function (el) {
        var known = scrollMemory.get(el);
        var top = el.scrollTop || 0;
        var left = el.scrollLeft || 0;
        var maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
        var clamped = !!(known && known.top > top + 1 && top >= maxTop - 1);
        if (!known && !top && !left) return;
        if (!clamped) scrollMemory.set(el, { top: top, left: left });
      });
    }
    function recall(node) {
      eachBox(node, function (el) {
        var known = scrollMemory.get(el);
        if (!known) return;
        if (el.scrollTop !== known.top) el.scrollTop = known.top;
        if (el.scrollLeft !== known.left) el.scrollLeft = known.left;
      });
    }
    function place(node, host, animate) {
      if (!node || !host || node.parentNode === host) return;
      remember(node);
      host.appendChild(node);
      recall(node);
      window.requestAnimationFrame(function () { recall(node); });
      if (!animate || reduced) {
        node.classList.remove('slot-swap');
        return;
      }
      node.classList.remove('slot-swap');
      void node.offsetWidth;
      node.classList.add('slot-swap');
    }
    function render(animate) {
      var current = panelNode(state.center);
      if (current && !parked(current)) place(current, centerHost, animate);
      PANELS.forEach(function (id) {
        var node = panelNode(id);
        if (!node) return;
        if (id === state.center) node.setAttribute('aria-current', 'true');
        else node.removeAttribute('aria-current');
      });
      centerSlot.setAttribute('aria-label', (TITLES[state.center] || state.center) + ', center panel');
      state.bar.forEach(function (id, index) {
        var slot = slots[index];
        if (!slot) return;
        var button = slot.querySelector('.bar-swap');
        var host = slot.querySelector('.slot-host');
        var node = panelNode(id);
        if (button) {
          var title = TITLES[id] || id;
          button.textContent = title;
          button.dataset.swap = id;
          button.setAttribute('aria-label', 'Show ' + title + ' in the center');
        }
        if (node && host && !parked(node)) place(node, host, animate);
      });
    }
    bar.addEventListener('click', function (event) {
      var button = event.target.closest('.bar-swap');
      if (!button || !bar.contains(button)) return;
      var id = button.dataset.swap;
      var incoming = panelNode(id);
      var outgoing = panelNode(state.center);
      if (parked(incoming) || parked(outgoing)) {
        if (parked(incoming) && window.HQWindows && window.HQWindows.open) window.HQWindows.open(id);
        return;
      }
      var next = swap(state, id);
      if (next.center === state.center) return;
      state = next;
      try { saveState(storage, state); } catch (e) {}
      render(true);
      var shown = panelNode(state.center);
      if (shown) {
        if (!shown.hasAttribute('tabindex')) shown.setAttribute('tabindex', '-1');
        shown.focus();
      }
    });
    render(false);
  }

  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
