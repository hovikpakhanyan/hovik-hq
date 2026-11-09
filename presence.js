(function (root) {
  var state = 'idle';
  var reason = 'Tap the core to listen on this device. Nothing is recorded, and this is not a live assistant.';
  var stream = null;
  var audioCtx = null;
  var micSerial = 0;
  var micOwner = 0;
  var micPending = false;
  var raf = 0;
  var reduced = false;
  var hiddenPause = false;
  var batteryPause = false;
  var particlesOn = false;

  function setState(next, note) {
    state = next;
    if (note) reason = note;
    var core = document.getElementById('command-core');
    var label = document.getElementById('presence-state');
    var noteEl = document.getElementById('presence-note');
    if (core) core.setAttribute('data-presence', state);
    var words = {
      listening: 'Listening locally',
      speaking: 'Local message',
      pending: 'Waiting',
      denied: 'Denied',
      error: 'Error',
      disconnected: 'Microphone off',
      idle: 'Idle'
    };
    if (label) label.textContent = words[state] || 'Idle';
    if (noteEl) noteEl.textContent = reason;
    if (core) {
      core.setAttribute('aria-pressed', state === 'listening' || state === 'pending' ? 'true' : 'false');
      core.setAttribute('aria-label', 'Command core. ' + reason);
    }
  }

  function stopTracks(media) {
    if (!media || !media.getTracks) return;
    media.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
  }
  function closeAudio() {
    if (!audioCtx) return;
    var ctx = audioCtx;
    audioCtx = null;
    ctx.close().catch(function () {});
  }
  function signedIn() {
    var app = document.getElementById('app');
    return !!(app && app.classList.contains('on'));
  }
  function release(why) {
    micOwner = 0;
    micPending = false;
    stopTracks(stream);
    stream = null;
    closeAudio();
    micLevel = 0;
    var note = why === 'hidden' ? 'Microphone released because this page was hidden. It will not turn back on by itself.'
      : why === 'logout' ? 'Microphone released.'
      : why === 'error' ? 'Microphone stopped after an error. Nothing was recorded or sent.'
      : 'Microphone off. Nothing was recorded or sent.';
    setState(why === 'hidden' || why === 'error' ? 'disconnected' : 'idle', note);
  }

  function drawLevel(level) {
    var bars = document.querySelectorAll('.core-wave i');
    for (var i = 0; i < bars.length; i++) {
      var wobble = 0.25 + ((i * 17) % 10) / 30;
      var h = stream ? Math.max(0.12, Math.min(1, level * wobble * 3)) : 0.18;
      bars[i].style.transform = 'scaleY(' + h + ')';
    }
  }

  var fieldTime = 0;
  var micLevel = 0;
  var assistantLevel = 0;
  var wisps = [];
  (function buildSphere() {
    var seed = 11;
    function rnd() {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    }
    function unit() {
      var z = rnd() * 2 - 1;
      var t = rnd() * 6.283185;
      var r = Math.sqrt(Math.max(0, 1 - z * z));
      return { x: Math.cos(t) * r, y: z, z: Math.sin(t) * r };
    }
    function perp(n) {
      var a = Math.abs(n.x) < 0.8 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
      var x = a.y * n.z - a.z * n.y;
      var y = a.z * n.x - a.x * n.z;
      var z = a.x * n.y - a.y * n.x;
      var len = Math.hypot(x, y, z) || 1;
      return { x: x / len, y: y / len, z: z / len };
    }
    function cross(a, b) {
      return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x
      };
    }
    function addArc(kind, radius, arc, steps) {
      var n = unit();
      if (kind === 'shell' && n.x + n.y * 0.4 < 0 && rnd() < 0.45) return;
      var u = perp(n);
      var v = cross(n, u);
      var phase = rnd() * 6.283185;
      var pts = [];
      for (var i = 0; i < steps; i++) {
        var a = phase + (i / (steps - 1) - 0.5) * arc;
        var c = Math.cos(a), s = Math.sin(a);
        pts.push({
          x: (n.x * c + u.x * s) * radius,
          y: (n.y * c + u.y * s) * radius,
          z: (n.z * c + u.z * s) * radius
        });
      }
      wisps.push({
        pts: pts,
        drift: { x: (rnd() - 0.5) * 0.55, y: (rnd() - 0.5) * 0.55, z: (rnd() - 0.5) * 0.55 },
        spin: rnd() < 0.5 ? 0.22 : -0.17,
        kind: kind
      });
    }
    var i;
    for (i = 0; i < 170; i++) addArc('shell', 0.84 + rnd() * 0.16, 0.95 + rnd() * 0.7, 7);
    for (i = 0; i < 55; i++) addArc('inner', 0.3 + rnd() * 0.22, 0.8 + rnd() * 0.55, 6);
    for (i = 0; i < 22; i++) {
      var n = unit();
      if (n.y < -0.2 && rnd() < 0.5) continue;
      var inner = 0.72, outer = 1.16 + rnd() * 0.12;
      wisps.push({
        pts: [
          { x: n.x * inner, y: n.y * inner, z: n.z * inner },
          { x: n.x * outer, y: n.y * outer, z: n.z * outer }
        ],
        drift: { x: (rnd() - 0.5) * 0.6, y: (rnd() - 0.5) * 0.6, z: (rnd() - 0.5) * 0.6 },
        spin: 0.12,
        kind: 'strut'
      });
    }
  })();

  function smoothstep(t) {
    t = Math.max(0, Math.min(1, t));
    return t * t * (3 - 2 * t);
  }
  function gatherAmount(time) {
    var u = (time % 18) / 18;
    if (u < 0.26) return 0;
    if (u < 0.4) return smoothstep((u - 0.26) / 0.14);
    if (u < 0.66) return 1;
    if (u < 0.84) return 1 - smoothstep((u - 0.66) / 0.18);
    return 0;
  }
  function rotY(p, a) {
    var c = Math.cos(a), s = Math.sin(a);
    return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
  }

  function fieldAnchor(w, h) {
    var canvas = document.getElementById('core-field');
    var core = document.getElementById('command-core');
    if (!canvas || !core) return { x: w * 0.5, y: h * 0.46, core: Math.min(w, h) * 0.16 };
    var cr = canvas.getBoundingClientRect();
    var br = core.getBoundingClientRect();
    var sx = w / Math.max(1, cr.width);
    var sy = h / Math.max(1, cr.height);
    return {
      x: (br.left + br.width / 2 - cr.left) * sx,
      y: (br.top + br.height / 2 - cr.top) * sy,
      core: Math.min(br.width, br.height) / 2 * sx
    };
  }

  function project(p, spin, nod, breathe, cx, cy, R) {
    var y1 = p.y * Math.cos(nod) - p.z * Math.sin(nod);
    var z1 = p.y * Math.sin(nod) + p.z * Math.cos(nod);
    var q = rotY({ x: p.x, y: y1, z: z1 }, spin);
    var f = 2.15 / (2.35 + q.z);
    return {
      x: cx + q.x * f * R * breathe,
      y: cy + q.y * f * R * breathe * 0.94,
      z: q.z,
      depth: (q.z + 1.2) / 2.3
    };
  }

  function paintField(ctx, w, h, time, level) {
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    var anchor = fieldAnchor(w, h);
    var cx = anchor.x, cy = anchor.y;
    var voice = assistantLevel;
    var form = Math.min(1, gatherAmount(time) * (1 - voice * 0.15) + voice * 0.9);
    var breathe = 1 + Math.sin(time * 0.6) * 0.01 + level * 0.08 + voice * 0.04;
    var stageMin = Math.min(w, h);
    var R = Math.min(stageMin * 0.4, Math.max(anchor.core * 1.5, stageMin * 0.34));
    var nod = Math.sin(time * 0.2) * 0.1;
    var haze = ctx.createRadialGradient(cx - R * 0.05, cy - R * 0.04, R * 0.02, cx, cy, R);
    haze.addColorStop(0, 'rgba(255, 236, 200, 0.28)');
    haze.addColorStop(0.35, 'rgba(210, 140, 40, 0.1)');
    haze.addColorStop(0.78, 'rgba(120, 64, 12, 0.05)');
    haze.addColorStop(1, 'rgba(40, 20, 4, 0)');
    ctx.fillStyle = haze;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 6.283185);
    ctx.fill();
    var draw = [];
    for (var i = 0; i < wisps.length; i++) {
      var wisp = wisps[i];
      if (wisp.kind === 'strut' && form < 0.4) continue;
      var slide = 1 - form;
      var pts = [];
      var zSum = 0;
      for (var p = 0; p < wisp.pts.length; p++) {
        var src = wisp.pts[p];
        var moved = {
          x: src.x + wisp.drift.x * slide,
          y: src.y + wisp.drift.y * slide,
          z: src.z + wisp.drift.z * slide
        };
        var q = project(moved, time * wisp.spin, nod, breathe, cx, cy, R);
        pts.push(q);
        zSum += q.z;
      }
      draw.push({ pts: pts, z: zSum / pts.length, kind: wisp.kind });
    }
    draw.sort(function (a, b) { return a.z - b.z; });
    for (i = 0; i < draw.length; i++) {
      var item = draw[i];
      var depth = 0;
      for (p = 0; p < item.pts.length; p++) depth += item.pts[p].depth;
      depth /= item.pts.length;
      if (item.kind !== 'strut') {
        var dot = item.pts[0];
        ctx.fillStyle = depth > 0.62 ? 'rgba(255, 244, 214, 0.85)' : 'rgba(196, 130, 40, 0.45)';
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, depth > 0.62 ? 1.5 : 0.8, 0, 6.283185);
        ctx.fill();
      }
      var fade = item.kind === 'strut' ? Math.max(0, (form - 0.55) / 0.45) : Math.max(0, (form - 0.08) / 0.92);
      if (fade < 0.04) continue;
      var alpha = ((item.kind === 'inner' ? 0.5 : 0.34) + depth * 0.55) * fade;
      var near = depth > 0.6;
      ctx.strokeStyle = near ? 'rgba(255, 220, 150, ' + alpha + ')' : 'rgba(140, 78, 18, ' + (alpha * 0.65) + ')';
      ctx.lineWidth = item.kind === 'strut' ? 1.3 : (near ? 1.7 : 0.7);
      ctx.beginPath();
      ctx.moveTo(item.pts[0].x, item.pts[0].y);
      if (item.pts.length === 2) ctx.lineTo(item.pts[1].x, item.pts[1].y);
      else {
        for (p = 1; p < item.pts.length - 1; p++) ctx.quadraticCurveTo(item.pts[p].x, item.pts[p].y, (item.pts[p].x + item.pts[p + 1].x) / 2, (item.pts[p].y + item.pts[p + 1].y) / 2);
        var last = item.pts[item.pts.length - 1];
        ctx.lineTo(last.x, last.y);
      }
      ctx.stroke();
    }
    var nx = cx - R * 0.03, ny = cy - R * 0.02;
    var coreR = R * (0.09 + voice * 0.02);
    var nucleus = ctx.createRadialGradient(nx, ny, 0, nx, ny, coreR);
    nucleus.addColorStop(0, 'rgba(255, 250, 240, 0.95)');
    nucleus.addColorStop(0.42, 'rgba(255, 190, 80, 0.55)');
    nucleus.addColorStop(1, 'rgba(150, 80, 12, 0)');
    ctx.fillStyle = nucleus;
    ctx.beginPath();
    ctx.ellipse(nx, ny, coreR, coreR * 0.72, -0.4, 0, 6.283185);
    ctx.fill();
  }

  function loopParticles(canvas) {
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    function frame(now) {
      fieldTime = (now || 0) / 1000;
      paintField(ctx, canvas.width, canvas.height, reduced ? 8 : fieldTime, micLevel);
      if (reduced || hiddenPause || batteryPause || !particlesOn) { raf = 0; return; }
      raf = requestAnimationFrame(frame);
    }
    if (reduced || hiddenPause || batteryPause) { paintField(ctx, canvas.width, canvas.height, 8, 0); return; }
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function startField() {
    var canvas = document.getElementById('core-field');
    if (!canvas) return;
    function fit() {
      var rect = canvas.parentElement.getBoundingClientRect();
      var w = Math.max(2, Math.round(rect.width));
      var h = Math.max(2, Math.round(rect.height));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(canvas.parentElement);
    window.addEventListener('resize', fit);
    particlesOn = !reduced && !hiddenPause && !batteryPause;
    loopParticles(canvas);
  }

  function finishIfOwner(ticket) {
    if (micOwner !== ticket) return;
    micPending = false;
    micOwner = 0;
  }
  async function toggleMic() {
    if (micPending) return;
    if (stream) { release('stop'); return; }
    if (document.hidden || !signedIn()) {
      setState('disconnected', 'Microphone stays off while this page is hidden or signed out.');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setState('disconnected', 'This browser has no microphone API. Nothing was recorded.');
      return;
    }
    var ticket = ++micSerial;
    micOwner = ticket;
    micPending = true;
    setState('pending', 'Waiting for microphone permission on this device. Nothing is recorded yet.');
    var acquired = null;
    var ctx = null;
    try {
      acquired = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
      if (micOwner !== ticket || document.hidden || !signedIn()) {
        stopTracks(acquired);
        finishIfOwner(ticket);
        return;
      }
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      var src = ctx.createMediaStreamSource(acquired);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      if (micOwner !== ticket || document.hidden || !signedIn()) {
        stopTracks(acquired);
        ctx.close().catch(function () {});
        finishIfOwner(ticket);
        return;
      }
      if (stream && stream !== acquired) stopTracks(stream);
      stream = acquired;
      audioCtx = ctx;
      finishIfOwner(ticket);
      var data = new Uint8Array(analyser.fftSize);
      setState('listening', 'Level follows this browser microphone only. Nothing is recorded, uploaded, or sent to a voice assistant.');
      (function pump() {
        if (stream !== acquired || document.hidden || !signedIn()) {
          if (stream === acquired) release('hidden');
          return;
        }
        analyser.getByteTimeDomainData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i++) {
          var v = (data[i] - 128) / 128;
          sum += v * v;
        }
        var heard = Math.min(1, Math.sqrt(sum / data.length) * 4);
        micLevel += (heard - micLevel) * 0.18;
        requestAnimationFrame(pump);
      })();
      acquired.getTracks().forEach(function (t) {
        t.addEventListener('ended', function () { if (stream === acquired) release('error'); });
      });
    } catch (err) {
      stopTracks(acquired);
      if (ctx) ctx.close().catch(function () {});
      if (stream === acquired) stream = null;
      if (micOwner !== ticket) return;
      micPending = false;
      micOwner = 0;
      var name = err && err.name;
      if (name === 'NotAllowedError') setState('denied', 'Microphone permission was denied. Nothing was recorded.');
      else if (name === 'NotFoundError') setState('error', 'No microphone was found. Nothing was recorded.');
      else setState('error', 'Microphone could not start. Nothing was recorded or sent.');
    }
  }

  function markSpeaking() {}
  function setAssistantEnergy(level) {
    assistantLevel = Math.max(0, Math.min(1, Number(level) || 0));
    if (reduced || hiddenPause || batteryPause || !particlesOn) {
      var canvas = document.getElementById('core-field');
      if (!canvas) return;
      paintField(canvas.getContext('2d'), canvas.width, canvas.height, 8, micLevel);
    }
  }

  function boot() {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', function (e) {
      reduced = e.matches;
      if (reduced && raf) { cancelAnimationFrame(raf); raf = 0; particlesOn = false; }
      else startField();
    });
    document.addEventListener('visibilitychange', function () {
      hiddenPause = document.hidden;
      if (document.hidden) {
        if (raf) { cancelAnimationFrame(raf); raf = 0; particlesOn = false; }
        release('hidden');
      } else if (!reduced && !batteryPause) {
        particlesOn = true;
        startField();
      }
    });
    window.addEventListener('pagehide', function () { release('hidden'); });
    if (navigator.getBattery) {
      navigator.getBattery().then(function (b) {
        function check() {
          batteryPause = !b.charging && b.level < 0.15;
          if (batteryPause && raf) { cancelAnimationFrame(raf); raf = 0; particlesOn = false; }
        }
        b.addEventListener('levelchange', check);
        b.addEventListener('chargingchange', check);
        check();
      }).catch(function () {});
    }
    var coreBtn = document.getElementById('command-core');
    if (coreBtn) coreBtn.addEventListener('click', toggleMic);
    setState('idle');
    startField();
  }

  root.HQPresence = {
    release: release,
    markSpeaking: markSpeaking,
    setAssistantEnergy: setAssistantEnergy,
    boot: boot,
    getState: function () { return state; }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
