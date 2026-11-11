(function (root) {
  var TITLES = { agents: 'Agents', chat: 'Chat', listings: 'Listings', tasks: 'Tasks', markets: 'Markets' };
  var homes = new Map();
  var wins = new Map();
  var zTop = 1;
  var owner = '';
  var writing = true;

  function node(key) {
    if (key === 'agents') return document.querySelector('.agents');
    if (key === 'chat') return document.querySelector('.chat');
    return document.getElementById(key + '-panel');
  }
  function host() { return document.getElementById('workspace'); }
  function phone() { return window.innerWidth <= 1000; }
  function keyName() { return owner ? 'hq.windows.v1.' + owner : ''; }
  function read() {
    if (!keyName()) return {};
    try { return JSON.parse(localStorage.getItem(keyName()) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function write() {
    if (!writing || !keyName()) return;
    var layout = {};
    wins.forEach(function (win, name) {
      layout[name] = { x: win.x, y: win.y, w: win.w, h: win.h, min: win.min, max: win.max };
    });
    localStorage.setItem(keyName(), JSON.stringify(layout));
  }
  function box() {
    var el = host();
    var r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, top: r.top };
  }
  function clamp(win) {
    var b = box();
    var minW = Math.min(300, Math.max(160, b.w - 16));
    var minH = Math.min(220, Math.max(140, b.h - 72));
    win.w = Math.max(minW, Math.min(win.w || minW, Math.max(minW, b.w - 8)));
    win.h = Math.max(minH, Math.min(win.h || minH, Math.max(minH, b.h - 64)));
    win.x = Math.max(0, Math.min(win.x || 0, Math.max(0, b.w - win.w)));
    win.y = Math.max(0, Math.min(win.y || 0, Math.max(0, b.h - 48)));
  }
  function place(win) {
    var el = win.el;
    el.hidden = !!win.min;
    el.style.zIndex = String(20 + win.z);
    el.classList.toggle('is-max', !win.min && (phone() || win.max));
    if (!win.min && !phone() && !win.max) {
      el.style.left = win.x + 'px';
      el.style.top = win.y + 'px';
      el.style.width = win.w + 'px';
      el.style.height = win.h + 'px';
    } else {
      el.style.left = '';
      el.style.top = '';
      el.style.width = '';
      el.style.height = '';
    }
    var maxBtn = el.querySelector('[data-act="max"]');
    if (maxBtn) maxBtn.setAttribute('aria-pressed', win.max || phone() ? 'true' : 'false');
  }
  function dock() {
    var bar = document.getElementById('win-dock');
    var items = document.getElementById('win-dock-items');
    if (!bar || !items) return;
    items.innerHTML = '';
    var names = Object.keys(TITLES);
    bar.hidden = wins.size === 0;
    document.querySelector('.stage').classList.toggle('windows-open', wins.size > 0);
    names.forEach(function (name) {
      var win = wins.get(name);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'win-chip';
      btn.textContent = TITLES[name];
      btn.setAttribute('aria-pressed', win && !win.min ? 'true' : 'false');
      btn.addEventListener('click', function () {
        if (!win) open(name);
        else { win.min = false; focus(name); }
      });
      items.appendChild(btn);
    });
  }
  function focus(name) {
    var win = wins.get(name);
    if (!win) return;
    win.min = false;
    win.z = ++zTop;
    place(win);
    dock();
    write();
    var title = win.el.querySelector('.hq-win-title');
    if (title) title.focus();
  }
  function frame(name) {
    var el = document.createElement('section');
    el.className = 'hq-win';
    el.dataset.module = name;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', TITLES[name] || name);
    el.innerHTML = '<header class="hq-win-bar">' +
      '<button type="button" class="hq-win-title">' + (TITLES[name] || name) + '</button>' +
      '<button type="button" data-act="min" aria-label="Minimize ' + (TITLES[name] || name) + '">–</button>' +
      '<button type="button" data-act="max" aria-label="Maximize ' + (TITLES[name] || name) + '">□</button>' +
      '<button type="button" data-act="close" aria-label="Close ' + (TITLES[name] || name) + '">×</button>' +
      '</header><div class="hq-win-body"></div>' +
      '<button type="button" class="hq-win-resize" aria-label="Resize ' + (TITLES[name] || name) + '"></button>';
    return el;
  }
  function open(name) {
    if (!TITLES[name] || !node(name)) return null;
    var existing = wins.get(name);
    if (existing) { existing.min = false; focus(name); return existing; }
    var content = node(name);
    if (!homes.has(content)) homes.set(content, { parent: content.parentNode, next: content.nextSibling });
    var el = frame(name);
    el.querySelector('.hq-win-body').appendChild(content);
    content.classList.add('in-window');
    host().appendChild(el);
    var saved = read()[name] || {};
    var b = box();
    var n = wins.size;
    var win = {
      key: name, el: el, content: content,
      x: Number.isFinite(saved.x) ? saved.x : 16 + n * 28,
      y: Number.isFinite(saved.y) ? saved.y : 16 + n * 24,
      w: Number.isFinite(saved.w) ? saved.w : Math.min(440, Math.max(300, b.w - 40)),
      h: Number.isFinite(saved.h) ? saved.h : Math.min(360, Math.max(220, b.h - 90)),
      min: false,
      max: phone() ? true : !!saved.max,
      z: ++zTop
    };
    clamp(win);
    wins.set(name, win);
    wire(win);
    place(win);
    dock();
    write();
    return win;
  }
  function close(name) {
    var win = wins.get(name);
    if (!win) return;
    var home = homes.get(win.content);
    win.content.classList.remove('in-window');
    if (home && home.parent) {
      if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(win.content, home.next);
      else home.parent.appendChild(win.content);
    }
    win.el.remove();
    wins.delete(name);
    dock();
    write();
  }
  function front() {
    var best = null;
    wins.forEach(function (win) { if (!win.min && (!best || win.z > best.z)) best = win; });
    return best;
  }
  function wire(win) {
    var bar = win.el.querySelector('.hq-win-bar');
    bar.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      win.z = ++zTop;
      place(win);
      if (e.target.closest('button') && !e.target.classList.contains('hq-win-title')) return;
      if (phone() || win.max) return;
      var b = box();
      var drag = { x: e.clientX - b.left - win.x, y: e.clientY - b.top - win.y };
      bar.setPointerCapture(e.pointerId);
      function move(ev) {
        if (ev.pointerId !== e.pointerId) return;
        win.x = ev.clientX - b.left - drag.x;
        win.y = ev.clientY - b.top - drag.y;
        clamp(win);
        place(win);
      }
      function up(ev) {
        if (ev.pointerId !== e.pointerId) return;
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        write();
      }
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
    win.el.querySelector('[data-act="min"]').addEventListener('click', function () {
      win.min = true;
      place(win);
      dock();
      write();
    });
    win.el.querySelector('[data-act="max"]').addEventListener('click', function () {
      if (phone()) { win.min = false; focus(win.key); return; }
      win.max = !win.max;
      win.min = false;
      place(win);
      write();
    });
    win.el.querySelector('[data-act="close"]').addEventListener('click', function () { close(win.key); });
    var handle = win.el.querySelector('.hq-win-resize');
    handle.addEventListener('pointerdown', function (e) {
      if (phone() || win.max) return;
      e.preventDefault();
      e.stopPropagation();
      var b = box();
      var start = { x: e.clientX, y: e.clientY, w: win.w, h: win.h };
      handle.setPointerCapture(e.pointerId);
      function move(ev) {
        win.w = start.w + (ev.clientX - start.x);
        win.h = start.h + (ev.clientY - start.y);
        clamp(win);
        place(win);
      }
      function up(ev) {
        if (ev.pointerId !== e.pointerId) return;
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        write();
      }
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
  function bind(userId) {
    var next = String(userId || '');
    if (next === owner && wins.size) return;
    writing = false;
    Array.from(wins.keys()).forEach(close);
    writing = true;
    owner = next;
    var saved = read();
    Object.keys(saved).forEach(function (name) { if (TITLES[name]) open(name); });
  }
  function reset() {
    if (keyName()) localStorage.removeItem(keyName());
    writing = false;
    Array.from(wins.keys()).forEach(close);
    writing = true;
  }
  function bootLaunchers() {
    [
      ['.agents .panel-label', 'agents'],
      ['.chat-head', 'chat'],
      ['#listings-panel h4', 'listings'],
      ['#tasks-panel h4', 'tasks'],
      ['#markets-panel h4', 'markets']
    ].forEach(function (pair) {
      var el = document.querySelector(pair[0]);
      if (!el || el.querySelector('.float-panel')) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'float-panel';
      btn.textContent = 'Window';
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        open(pair[1]);
      });
      el.appendChild(btn);
    });
    var resetBtn = document.getElementById('win-reset');
    if (resetBtn) resetBtn.addEventListener('click', reset);
    window.addEventListener('resize', function () {
      wins.forEach(function (win) { clamp(win); place(win); });
    });
  }
  root.HQWindows = {
    open: open,
    close: close,
    closeFront: function () { var win = front(); if (win) close(win.key); },
    bind: bind,
    reset: reset,
    front: function () { var win = front(); return win ? win.key : ''; },
    z: function (name) { var win = wins.get(name); return win ? win.z : 0; },
    ownerKey: keyName
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootLaunchers);
  else bootLaunchers();
})(typeof globalThis !== 'undefined' ? globalThis : this);
