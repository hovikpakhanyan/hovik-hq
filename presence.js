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
  var shells = [];
  var dust = [];
  (function buildSphere() {
    function tilt(x, y, z, ax, ay) {
      var cy = Math.cos(ax), sy = Math.sin(ax);
      var cz = Math.cos(ay), sz = Math.sin(ay);
      var y1 = y * cy - z * sy;
      var z1 = y * sy + z * cy;
      return { x: x * cz - z1 * sz, y: y1, z: x * sz + z1 * cz };
    }
    var rings = [
      { ax: 0.15, ay: 0.05, r: 1.0, n: 120, spin: 0.38, gap: 16, keep: 12 },
      { ax: 0.15, ay: 0.05, r: 0.94, n: 110, spin: 0.38, gap: 14, keep: 8 },
      { ax: 1.05, ay: 0.4, r: 0.97, n: 112, spin: -0.29, gap: 15, keep: 11 },
      { ax: 1.05, ay: 0.4, r: 0.9, n: 100, spin: -0.29, gap: 12, keep: 7 },
      { ax: 1.7, ay: -0.5, r: 0.92, n: 108, spin: 0.22, gap: 13, keep: 9 },
      { ax: 0.55, ay: 1.2, r: 0.86, n: 96, spin: -0.33, gap: 14, keep: 9 },
      { ax: 2.3, ay: 0.75, r: 0.8, n: 90, spin: 0.26, gap: 11, keep: 7 },
      { ax: 0.85, ay: 2.05, r: 0.58, n: 72, spin: -0.46, gap: 9, keep: 6 },
      { ax: 0.25, ay: 0.7, r: 0.4, n: 56, spin: 0.52, gap: 8, keep: 5 },
      { ax: 1.4, ay: 1.5, r: 0.28, n: 44, spin: -0.6, gap: 7, keep: 4 }
    ];
    rings.forEach(function (ring) {
      var pts = [];
      for (var i = 0; i < ring.n; i++) {
        var a = (i / ring.n) * 6.283185;
        pts.push(tilt(Math.cos(a) * ring.r, Math.sin(a) * ring.r, 0, ring.ax, ring.ay));
      }
      shells.push({ pts: pts, spin: ring.spin, gap: ring.gap, keep: ring.keep, r: ring.r });
    });
    for (var i = 0; i < 420; i++) {
      var y = 1 - (i / 419) * 2;
      var rad = Math.sqrt(Math.max(0, 1 - y * y));
      var th = i * 2.399963;
      var shell = 0.62 + (i % 7) * 0.055;
      dust.push({
        x: Math.cos(th) * rad * shell,
        y: y * shell,
        z: Math.sin(th) * rad * shell,
        tw: (i % 13) / 13,
        spin: i % 2 ? 0.33 : -0.27
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
    var breathe = 1 + Math.sin(time * 0.65) * 0.012 + level * 0.1 + voice * 0.04;
    var R = Math.max(48, anchor.core * (1.22 + form * 0.08));
    var nod = Math.sin(time * 0.23) * 0.18;
    var haze = ctx.createRadialGradient(cx - R * 0.08, cy - R * 0.06, R * 0.05, cx, cy, R * 1.08);
    haze.addColorStop(0, 'rgba(255, 236, 196, 0.42)');
    haze.addColorStop(0.28, 'rgba(214, 146, 42, 0.16)');
    haze.addColorStop(0.72, 'rgba(140, 78, 16, 0.08)');
    haze.addColorStop(1, 'rgba(80, 40, 8, 0)');
    ctx.fillStyle = haze;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.08, 0, 6.283185);
    ctx.fill();
    var pieces = [];
    shells.forEach(function (shell) {
      var spin = time * shell.spin;
      var keep = shell.keep + Math.round(form * 3);
      var projected = [];
      for (var i = 0; i < shell.pts.length; i++) projected.push(project(shell.pts[i], spin, nod, breathe, cx, cy, R));
      for (var s = 0; s < projected.length; s++) {
        if ((s % shell.gap) >= keep) continue;
        var a = projected[s];
        var b = projected[(s + 1) % projected.length];
        var dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist < 1.5 || dist > R * 0.22) continue;
        pieces.push({ a: a, b: b, z: (a.z + b.z) / 2, depth: (a.depth + b.depth) / 2, inner: shell.r < 0.5 });
      }
    });
    pieces.sort(function (p, q) { return p.z - q.z; });
    for (var n = 0; n < pieces.length; n++) {
      var seg = pieces[n];
      var alpha = (seg.inner ? 0.28 : 0.14) + seg.depth * (0.35 + form * 0.4);
      ctx.strokeStyle = seg.depth > 0.62 ? 'rgba(255, 196, 90, ' + (alpha * 0.45) + ')' : 'rgba(140, 78, 18, ' + (alpha * 0.35) + ')';
      ctx.lineWidth = seg.depth > 0.62 ? 3.2 : 1.8;
      var mx0 = (seg.a.x + seg.b.x) / 2;
      var my0 = (seg.a.y + seg.b.y) / 2;
      var dx0 = mx0 - cx, dy0 = my0 - cy;
      var len0 = Math.hypot(dx0, dy0) || 1;
      var bow0 = Math.min(8, Math.hypot(seg.a.x - seg.b.x, seg.a.y - seg.b.y) * 0.4);
      ctx.beginPath();
      ctx.moveTo(seg.a.x, seg.a.y);
      ctx.quadraticCurveTo(mx0 + dx0 / len0 * bow0, my0 + dy0 / len0 * bow0, seg.b.x, seg.b.y);
      ctx.stroke();
      ctx.strokeStyle = seg.depth > 0.62 ? 'rgba(255, 228, 170, ' + alpha + ')' : 'rgba(190, 120, 36, ' + (alpha * 0.85) + ')';
      ctx.lineWidth = seg.depth > 0.62 ? 1.15 : 0.65;
      var mx = (seg.a.x + seg.b.x) / 2;
      var my = (seg.a.y + seg.b.y) / 2;
      var dx = mx - cx, dy = my - cy;
      var len = Math.hypot(dx, dy) || 1;
      var bow = Math.min(7, Math.hypot(seg.a.x - seg.b.x, seg.a.y - seg.b.y) * 0.35);
      ctx.beginPath();
      ctx.moveTo(seg.a.x, seg.a.y);
      ctx.quadraticCurveTo(mx + dx / len * bow, my + dy / len * bow, seg.b.x, seg.b.y);
      ctx.stroke();
    }
    for (var d = 0; d < dust.length; d++) {
      var mote = dust[d];
      var loose = 1 + (1 - form) * 0.06 * Math.sin(time * 0.8 + mote.tw * 6.28);
      var p = project({ x: mote.x * loose, y: mote.y * loose, z: mote.z * loose }, time * mote.spin, nod, breathe, cx, cy, R);
      var glitter = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(time * 1.7 + mote.tw * 12));
      var bright = p.depth > 0.7 && glitter > 0.72;
      ctx.fillStyle = bright ? 'rgba(255, 248, 230, ' + (0.55 + p.depth * 0.4) + ')' : 'rgba(214, 154, 52, ' + (0.12 + p.depth * 0.4 * glitter) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, bright ? 1.7 : 0.7 + p.depth, 0, 6.283185);
      ctx.fill();
    }
    var nx = cx - R * 0.04, ny = cy - R * 0.03;
    var coreR = R * (0.11 + voice * 0.02);
    var nucleus = ctx.createRadialGradient(nx, ny, 0, nx, ny, coreR);
    nucleus.addColorStop(0, 'rgba(255, 250, 240, 0.92)');
    nucleus.addColorStop(0.45, 'rgba(255, 186, 70, 0.55)');
    nucleus.addColorStop(1, 'rgba(160, 90, 16, 0)');
    ctx.fillStyle = nucleus;
    ctx.beginPath();
    ctx.ellipse(nx, ny, coreR * 1.2, coreR * 0.78, -0.5, 0, 6.283185);
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
