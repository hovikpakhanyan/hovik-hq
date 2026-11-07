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
  var motes = [];
  (function buildMotes() {
    var planes = [
      { ax: 0.22, ay: 0.18, spin: 0.09 },
      { ax: 1.15, ay: 0.55, spin: -0.06 },
      { ax: 1.85, ay: -0.4, spin: 0.045 },
      { ax: 0.62, ay: 1.35, spin: -0.11 },
      { ax: 2.4, ay: 0.9, spin: 0.07 }
    ];
    function tilt(x, y, z, plane) {
      var cy = Math.cos(plane.ax), sy = Math.sin(plane.ax);
      var cz = Math.cos(plane.ay), sz = Math.sin(plane.ay);
      var y1 = y * cy - z * sy;
      var z1 = y * sy + z * cy;
      return { x: x * cz - z1 * sz, y: y1, z: x * sz + z1 * cz };
    }
    var pi, i, n = 36;
    for (pi = 0; pi < planes.length; pi++) {
      for (i = 0; i < n; i++) {
        if ((i + pi) % 7 === 0) continue;
        var a = (i / n) * 6.283185;
        var radius = 0.78 + (pi % 3) * 0.08;
        var shell = tilt(Math.cos(a) * radius, Math.sin(a) * radius, 0, planes[pi]);
        var flow = a + pi;
        var looseR = 0.88 + (i % 5) * 0.04;
        motes.push({
          sx: shell.x, sy: shell.y, sz: shell.z, plane: pi, spin: planes[pi].spin,
          dx: Math.cos(flow) * looseR, dy: Math.sin(flow * 1.7) * looseR * 0.82, dz: Math.sin(flow) * looseR,
          drift: 0.22 + (i % 5) * 0.05, size: i % 8 === 0 ? 2.2 : 1.2, link: i % 8 < 5, strut: false
        });
      }
    }
    for (i = 0; i < 22; i++) {
      var ang = i * 0.78 + 0.3;
      var outer = i % 3 === 0 ? 1.28 : 1.02;
      motes.push({
        sx: Math.cos(ang) * outer, sy: Math.sin(ang * 0.85) * outer * 0.7, sz: Math.sin(ang) * outer * 0.62,
        plane: i % 5, spin: 0.05 * (i % 2 ? -1 : 1),
        dx: Math.cos(ang + 1) * 0.9, dy: Math.sin(ang) * 0.75, dz: Math.sin(ang * 1.2) * 0.9,
        drift: 0.18, size: 1.5, link: false, strut: true
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

  function paintField(ctx, w, h, time, level) {
    ctx.clearRect(0, 0, w, h);
    var anchor = fieldAnchor(w, h);
    var cx = anchor.x, cy = anchor.y;
    var R = Math.min(Math.max(anchor.core * 2.5, Math.min(w, h) * 0.34), Math.min(w, h) * 0.48);
    var voice = assistantLevel;
    var form = Math.min(1, gatherAmount(time) * (1 - voice * 0.15) + voice * 0.9);
    var breathe = 1 + Math.sin(time * 0.7) * 0.015 + level * 0.12 + voice * 0.05;
    var nod = Math.sin(time * 0.21) * 0.12;
    var haze = ctx.createRadialGradient(cx - R * 0.04, cy - R * 0.05, R * 0.02, cx, cy, R * 1.05);
    haze.addColorStop(0, 'rgba(255, 244, 220, 0.55)');
    haze.addColorStop(0.16, 'rgba(226, 168, 64, 0.28)');
    haze.addColorStop(0.42, 'rgba(120, 72, 18, 0.12)');
    haze.addColorStop(1, 'rgba(80, 48, 10, 0)');
    ctx.fillStyle = haze;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.35, 0, 6.283185);
    ctx.fill();
    var drawn = [];
    var prev = {};
    for (var i = 0; i < motes.length; i++) {
      var m = motes[i];
      var spin = time * m.spin;
      var structured = rotY({ x: m.sx, y: m.sy * Math.cos(nod) - m.sz * Math.sin(nod), z: m.sy * Math.sin(nod) + m.sz * Math.cos(nod) }, spin);
      var looseA = time * m.drift + i;
      var loose = {
        x: m.dx + Math.cos(looseA) * 0.16,
        y: m.dy + Math.sin(looseA * 0.8) * 0.12,
        z: m.dz + Math.sin(looseA * 0.6) * 0.14
      };
      var p = {
        x: loose.x + (structured.x - loose.x) * form,
        y: loose.y + (structured.y - loose.y) * form,
        z: loose.z + (structured.z - loose.z) * form
      };
      var f = 2.5 / (2.5 + p.z);
      var sx = cx + p.x * f * R * breathe;
      var sy = cy + p.y * f * R * breathe * 0.9;
      var depth = (p.z + 1.35) / 2.5;
      drawn.push({ x: sx, y: sy, z: p.z, depth: depth, size: m.size * (0.65 + depth), i: i, link: m.link, plane: m.plane, strut: m.strut });
      if (m.link && prev[m.plane]) {
        var a = prev[m.plane];
        if (Math.abs(a.i - i) < 3) drawn[drawn.length - 1].line = a;
      }
      prev[m.plane] = drawn[drawn.length - 1];
    }
    drawn.sort(function (a, b) { return a.z - b.z; });
    for (var d = 0; d < drawn.length; d++) {
      var q = drawn[d];
      if (q.line && form > 0.08) {
        var alpha = (0.12 + q.depth * 0.7) * form;
        ctx.strokeStyle = q.depth > 0.55 ? 'rgba(255, 214, 140, ' + alpha + ')' : 'rgba(170, 104, 28, ' + (alpha * 0.75) + ')';
        ctx.lineWidth = q.depth > 0.6 ? 1.45 : 0.75;
        ctx.beginPath();
        ctx.moveTo(q.line.x, q.line.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
      if (q.strut && form > 0.35) {
        ctx.strokeStyle = 'rgba(255, 196, 96, ' + (0.35 * form * (0.4 + q.depth)) + ')';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + (q.x - cx) * 0.22, cy + (q.y - cy) * 0.22);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
    }
    for (d = 0; d < drawn.length; d++) {
      q = drawn[d];
      var bright = q.depth > 0.72;
      ctx.fillStyle = bright ? 'rgba(255, 248, 230, ' + (0.45 + q.depth * 0.5) + ')' : 'rgba(214, 150, 48, ' + (0.18 + q.depth * 0.45) + ')';
      ctx.beginPath();
      ctx.arc(q.x, q.y, Math.max(0.6, q.size), 0, 6.283185);
      ctx.fill();
    }
    var nx = cx - R * 0.05, ny = cy - R * 0.03;
    var coreR = R * (0.16 + voice * 0.03);
    var nucleus = ctx.createRadialGradient(nx, ny, coreR * 0.15, nx, ny, coreR);
    nucleus.addColorStop(0, 'rgba(255, 252, 245, 0.95)');
    nucleus.addColorStop(0.35, 'rgba(255, 196, 90, 0.75)');
    nucleus.addColorStop(1, 'rgba(180, 100, 20, 0)');
    ctx.fillStyle = nucleus;
    ctx.beginPath();
    ctx.ellipse(nx, ny, coreR * 1.15, coreR * 0.82, -0.4, 0, 6.283185);
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
