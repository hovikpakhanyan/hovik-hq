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
  var bodies = [];
  var links = [];
  var struts = [];
  (function buildSphere() {
    var seed = 7;
    function rnd() {
      seed = (seed * 16807 + 11) % 2147483647;
      return seed / 2147483647;
    }
    function tilt(x, y, z, ax, ay) {
      var cy = Math.cos(ax), sy = Math.sin(ax);
      var cz = Math.cos(ay), sz = Math.sin(ay);
      var y1 = y * cy - z * sy;
      var z1 = y * sy + z * cy;
      return { x: x * cz - z1 * sz, y: y1, z: x * sz + z1 * cz };
    }
    function cloud() {
      var u = rnd(), v = rnd(), w = rnd();
      var z = 2 * u - 1;
      var rad = Math.sqrt(Math.max(0, 1 - z * z));
      var th = v * 6.283185;
      var reach = 0.28 + w * 0.85;
      return { x: Math.cos(th) * rad * reach, y: z * reach, z: Math.sin(th) * rad * reach };
    }
    var rings = [
      { ax: 0.2, ay: 0.1, r: 0.98, n: 72, spin: 0.16 },
      { ax: 1.15, ay: 0.45, r: 0.9, n: 64, spin: -0.12 },
      { ax: 1.8, ay: -0.35, r: 0.82, n: 60, spin: 0.1 },
      { ax: 0.6, ay: 1.35, r: 0.72, n: 52, spin: -0.14 },
      { ax: 0.4, ay: 0.8, r: 0.42, n: 40, spin: 0.2 }
    ];
    rings.forEach(function (ring, ri) {
      var ids = [];
      for (var i = 0; i < ring.n; i++) {
        var a = (i / ring.n) * 6.283185;
        var home = tilt(Math.cos(a) * ring.r, Math.sin(a) * ring.r, 0, ring.ax, ring.ay);
        var id = bodies.length;
        bodies.push({ free: cloud(), home: home, spin: ring.spin, tw: rnd() });
        ids.push(id);
      }
      for (var s = 0; s < ring.n; s++) {
        var slot = (s + ri * 3) % 14;
        if (slot >= 5) continue;
        if (ri % 2 === 0 && s > ring.n * 0.55 && s < ring.n * 0.75) continue;
        links.push({ a: ids[s], b: ids[(s + 1) % ring.n], spin: ring.spin, inner: ring.r < 0.5 });
      }
    });
    for (var k = 0; k < 18; k++) {
      var ang = k * 0.85 + 0.4;
      var dir = tilt(Math.cos(ang), Math.sin(ang) * 0.72, Math.sin(ang * 0.7) * 0.55, 0.4, 0.2);
      var len = Math.hypot(dir.x, dir.y, dir.z) || 1;
      dir = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
      var inner = bodies.length;
      bodies.push({ free: cloud(), home: { x: dir.x * 0.34, y: dir.y * 0.34, z: dir.z * 0.34 }, spin: 0.08, tw: rnd() });
      var outer = bodies.length;
      bodies.push({ free: cloud(), home: { x: dir.x * 1.18, y: dir.y * 1.18, z: dir.z * 1.18 }, spin: 0.08, tw: rnd() });
      struts.push({ a: inner, b: outer });
    }
    for (var d = 0; d < 180; d++) bodies.push({ free: cloud(), home: cloud(), spin: d % 2 ? 0.11 : -0.09, tw: rnd(), mote: true });
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

  function mix(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
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
    var R = Math.max(48, anchor.core * 1.28);
    var nod = Math.sin(time * 0.23) * 0.12;
    var haze = ctx.createRadialGradient(cx - R * 0.06, cy - R * 0.04, R * 0.04, cx, cy, R * 1.05);
    haze.addColorStop(0, 'rgba(255, 228, 180, ' + (0.16 + form * 0.12) + ')');
    haze.addColorStop(0.45, 'rgba(180, 110, 28, ' + (0.05 + form * 0.06) + ')');
    haze.addColorStop(1, 'rgba(60, 30, 8, 0)');
    ctx.fillStyle = haze;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.05, 0, 6.283185);
    ctx.fill();
    var placed = [];
    for (var i = 0; i < bodies.length; i++) {
      var body = bodies[i];
      var drift = {
        x: body.free.x + Math.sin(time * 0.35 + body.tw * 6) * 0.05,
        y: body.free.y + Math.cos(time * 0.28 + body.tw * 4) * 0.05,
        z: body.free.z
      };
      placed.push(project(mix(drift, body.home, form), time * body.spin * (body.mote ? 1 : 0.35), nod, breathe, cx, cy, R));
    }
    var strokes = [];
    function consider(a, b, kind) {
      if (form < (kind === 'strut' ? 0.45 : 0.22)) return;
      var pa = placed[a], pb = placed[b];
      var dist = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      var limit = kind === 'strut' ? R * 0.85 : R * 0.18;
      if (dist < 1.2 || dist > limit) return;
      strokes.push({ a: pa, b: pb, z: (pa.z + pb.z) / 2, depth: (pa.depth + pb.depth) / 2, kind: kind });
    }
    for (var s = 0; s < links.length; s++) consider(links[s].a, links[s].b, links[s].inner ? 'inner' : 'shell');
    for (s = 0; s < struts.length; s++) consider(struts[s].a, struts[s].b, 'strut');
    strokes.sort(function (p, q) { return p.z - q.z; });
    for (var n = 0; n < strokes.length; n++) {
      var seg = strokes[n];
      var alpha = form * (0.2 + seg.depth * 0.65);
      if (seg.kind === 'strut') alpha *= 0.85;
      ctx.strokeStyle = seg.depth > 0.58 ? 'rgba(255, 220, 160, ' + alpha + ')' : 'rgba(150, 86, 20, ' + (alpha * 0.7) + ')';
      ctx.lineWidth = seg.kind === 'strut' ? 1.4 : (seg.depth > 0.58 ? 1.8 : 0.8);
      var mx = (seg.a.x + seg.b.x) / 2, my = (seg.a.y + seg.b.y) / 2;
      var dx = mx - cx, dy = my - cy, len = Math.hypot(dx, dy) || 1;
      var bow = seg.kind === 'strut' ? 0 : Math.min(6, Math.hypot(seg.a.x - seg.b.x, seg.a.y - seg.b.y) * 0.3);
      ctx.beginPath();
      ctx.moveTo(seg.a.x, seg.a.y);
      ctx.quadraticCurveTo(mx + dx / len * bow, my + dy / len * bow, seg.b.x, seg.b.y);
      ctx.stroke();
    }
    for (i = 0; i < placed.length; i++) {
      var p = placed[i];
      var bright = p.depth > 0.72;
      ctx.fillStyle = bright ? 'rgba(255, 246, 224, ' + (0.45 + p.depth * 0.5) + ')' : 'rgba(206, 142, 42, ' + (0.15 + p.depth * 0.45) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, (bright ? 1.8 : 0.9) * (0.7 + p.depth * 0.5), 0, 6.283185);
      ctx.fill();
    }
    var nx = cx - R * 0.04, ny = cy - R * 0.03;
    var coreR = R * (0.1 + voice * 0.02);
    var nucleus = ctx.createRadialGradient(nx, ny, 0, nx, ny, coreR);
    nucleus.addColorStop(0, 'rgba(255, 250, 240, 0.95)');
    nucleus.addColorStop(0.5, 'rgba(255, 186, 70, 0.5)');
    nucleus.addColorStop(1, 'rgba(160, 90, 16, 0)');
    ctx.fillStyle = nucleus;
    ctx.beginPath();
    ctx.ellipse(nx, ny, coreR * 1.15, coreR * 0.75, -0.45, 0, 6.283185);
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
