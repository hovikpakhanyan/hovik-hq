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
  var traces = [];
  (function buildCircuit() {
    function sph(lat, lon, r) {
      var cl = Math.cos(lat);
      return { x: cl * Math.cos(lon) * r, y: Math.sin(lat) * r, z: cl * Math.sin(lon) * r };
    }
    function push(kind, pts) {
      var mid = pts[0];
      traces.push({
        pts: pts,
        drift: {
          x: Math.sin(mid.y * 9 + mid.x * 4) * 0.42,
          y: Math.cos(mid.x * 7 + mid.z * 3) * 0.42,
          z: Math.sin(mid.z * 5 + mid.y * 6) * 0.42
        },
        kind: kind
      });
    }
    var shells = [0.98, 0.9, 0.8];
    var si, lat, lon, dLat, dLon, a, b, c;
    for (si = 0; si < shells.length; si++) {
      var radius = shells[si];
      for (lat = -1.15; lat <= 1.15; lat += 0.09) {
        dLat = 0.045;
        dLon = 0.055 / Math.max(0.28, Math.cos(lat));
        for (lon = 0; lon < 6.283185; lon += 0.105) {
          var cell = ((Math.round(lat * 20) + Math.round(lon * 12) + si * 3) % 9);
          if (cell === 0 || cell === 1) continue;
          if (lon > 2.2 && lon < 3.5 && lat > -0.2) continue;
          a = sph(lat, lon, radius);
          if (cell === 2 || cell === 3) {
            b = sph(lat, lon + dLon, radius);
            push('dash', [a, b]);
          } else if (cell === 4 || cell === 5) {
            b = sph(lat + dLat, lon, radius);
            push('dash', [a, b]);
          } else if (cell === 6) {
            b = sph(lat, lon + dLon * 0.8, radius);
            c = sph(lat + dLat * 0.8, lon + dLon * 0.8, radius);
            push('elbow', [a, b, c]);
          } else {
            b = sph(lat + dLat * 0.7, lon, radius);
            c = sph(lat + dLat * 0.7, lon + dLon * 0.65, radius);
            push('step', [a, b, c]);
          }
        }
      }
    }
    for (var s = 0; s < 18; s++) {
      var spikeLon = 0.35 + (s % 6) * 0.12;
      var spikeLat = -0.7 + Math.floor(s / 6) * 0.45;
      var inner = sph(spikeLat, spikeLon, 0.98);
      var outer = sph(spikeLat, spikeLon, 1.16);
      push('strut', [inner, outer]);
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
      depth: (1.15 - q.z) / 2.3
    };
  }

  function paintField(ctx, w, h, time, level) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    var anchor = fieldAnchor(w, h);
    var cx = anchor.x, cy = anchor.y;
    var voice = assistantLevel;
    var form = Math.min(1, gatherAmount(time) * (1 - voice * 0.15) + voice * 0.9);
    var breathe = 1 + level * 0.06 + voice * 0.03;
    var stageMin = Math.min(w, h);
    var R = Math.min(stageMin * 0.4, Math.max(anchor.core * 1.5, stageMin * 0.34));
    var nod = Math.sin(time * 0.2) * 0.08;
    var spin = time * 0.18;
    var slide = 1 - form;
    var bins = [[], [], [], [], [], [], [], []];
    var i, p, q, src, moved, depth, bin, len, radial;
    for (i = 0; i < traces.length; i++) {
      var trace = traces[i];
      if (trace.kind === 'strut' && form < 0.5) continue;
      var ax, ay, az, bx, by;
      for (p = 0; p < trace.pts.length - 1; p++) {
        src = trace.pts[p];
        moved = { x: src.x + trace.drift.x * slide, y: src.y + trace.drift.y * slide, z: src.z + trace.drift.z * slide };
        ax = project(moved, spin, nod, breathe, cx, cy, R);
        src = trace.pts[p + 1];
        moved = { x: src.x + trace.drift.x * slide, y: src.y + trace.drift.y * slide, z: src.z + trace.drift.z * slide };
        q = project(moved, spin, nod, breathe, cx, cy, R);
        len = Math.hypot(ax.x - q.x, ax.y - q.y);
        if (len < 0.6 || len > 14) continue;
        depth = (ax.depth + q.depth) / 2;
        radial = Math.hypot((ax.x + q.x) / 2 - cx, (ax.y + q.y) / 2 - cy) / R;
        bin = Math.max(0, Math.min(7, Math.floor(depth * 7)));
        if (radial > 0.72 && radial < 1.02) bin = Math.min(7, bin + 2);
        bins[bin].push(ax.x, ax.y, q.x, q.y);
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    var colors = [
      'rgba(160, 60, 0, 0.35)',
      'rgba(190, 80, 0, 0.4)',
      'rgba(220, 110, 10, 0.5)',
      'rgba(240, 140, 20, 0.6)',
      'rgba(255, 170, 30, 0.7)',
      'rgba(255, 200, 60, 0.8)',
      'rgba(255, 230, 120, 0.9)',
      'rgba(255, 250, 220, 0.95)'
    ];
    for (bin = 0; bin < 8; bin++) {
      var batch = bins[bin];
      if (!batch.length) continue;
      ctx.beginPath();
      for (i = 0; i < batch.length; i += 4) {
        ctx.moveTo(batch[i], batch[i + 1]);
        ctx.lineTo(batch[i + 2], batch[i + 3]);
      }
      ctx.strokeStyle = colors[bin];
      ctx.lineWidth = bin > 5 ? 1.6 : 1.05;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    if (form > 0.45) {
      var panels = [[-0.15, 0.4], [0.45, 1.6], [-0.55, 4.2]];
      ctx.fillStyle = 'rgba(255, 170, 40, ' + ((form - 0.45) * 0.22) + ')';
      for (i = 0; i < panels.length; i++) {
        var lat0 = panels[i][0], lon0 = panels[i][1];
        var corners = [
          project(sphLocal(lat0, lon0, 0.99), spin, nod, breathe, cx, cy, R),
          project(sphLocal(lat0 + 0.18, lon0, 0.99), spin, nod, breathe, cx, cy, R),
          project(sphLocal(lat0 + 0.18, lon0 + 0.16, 0.99), spin, nod, breathe, cx, cy, R),
          project(sphLocal(lat0, lon0 + 0.16, 0.99), spin, nod, breathe, cx, cy, R)
        ];
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        ctx.lineTo(corners[1].x, corners[1].y);
        ctx.lineTo(corners[2].x, corners[2].y);
        ctx.lineTo(corners[3].x, corners[3].y);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 2.4;
    var arcs = [
      { ax: 0.4, ay: 0.2, r: 0.36, spin: -0.25, a0: 0.2, a1: 4.2 },
      { ax: 1.1, ay: -0.3, r: 0.3, spin: 0.2, a0: 1.1, a1: 5.0 },
      { ax: -0.2, ay: 0.9, r: 0.24, spin: 0.15, a0: 0.6, a1: 4.4 }
    ];
    for (i = 0; i < arcs.length; i++) {
      var arc = arcs[i];
      ctx.beginPath();
      for (var s = 0; s <= 28; s++) {
        var ang = arc.a0 + (arc.a1 - arc.a0) * (s / 28);
        var pt = tiltLocal(Math.cos(ang) * arc.r, Math.sin(ang) * arc.r, 0, arc.ax, arc.ay);
        var pr = project(pt, time * arc.spin, nod, breathe, cx, cy, R);
        if (s === 0) ctx.moveTo(pr.x, pr.y); else ctx.lineTo(pr.x, pr.y);
      }
      ctx.strokeStyle = 'rgba(255, 196, 60, ' + (0.35 + form * 0.45) + ')';
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    var nx = cx - R * 0.02, ny = cy - R * 0.015;
    var coreR = R * (0.075 + voice * 0.015);
    var nucleus = ctx.createRadialGradient(nx, ny, coreR * 0.2, nx, ny, coreR);
    nucleus.addColorStop(0, 'rgba(255, 255, 245, 0.98)');
    nucleus.addColorStop(0.35, 'rgba(255, 210, 90, 0.85)');
    nucleus.addColorStop(0.7, 'rgba(255, 140, 20, 0.35)');
    nucleus.addColorStop(1, 'rgba(120, 50, 0, 0)');
    ctx.fillStyle = nucleus;
    ctx.beginPath();
    ctx.ellipse(nx, ny, coreR, coreR * 0.78, -0.35, 0, 6.283185);
    ctx.fill();
  }

  function sphLocal(lat, lon, r) {
    var cl = Math.cos(lat);
    return { x: cl * Math.cos(lon) * r, y: Math.sin(lat) * r, z: cl * Math.sin(lon) * r };
  }
  function tiltLocal(x, y, z, ax, ay) {
    var cy = Math.cos(ax), sy = Math.sin(ax);
    var cz = Math.cos(ay), sz = Math.sin(ay);
    var y1 = y * cy - z * sy;
    var z1 = y * sy + z * cy;
    return { x: x * cz - z1 * sz, y: y1, z: x * sz + z1 * cz };
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
