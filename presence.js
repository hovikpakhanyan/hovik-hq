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
  var dots = [];
  for (var di = 0; di < 42; di++) dots.push({ a: Math.random() * 6.28, r: 0.34 + Math.random() * 0.58, s: 0.006 + Math.random() * 0.016, w: 0.6 + Math.random() * 1.6 });

  function paintField(ctx, w, h, time, level) {
    ctx.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.47;
    var wash = ctx.createRadialGradient(cx, cy, R * 0.02, cx, cy, R);
    wash.addColorStop(0, 'rgba(236, 255, 252, 0.95)');
    wash.addColorStop(0.08, 'rgba(94, 234, 212, 0.45)');
    wash.addColorStop(0.22, 'rgba(20, 70, 78, 0.18)');
    wash.addColorStop(1, 'rgba(94, 234, 212, 0)');
    ctx.fillStyle = wash;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 6.28);
    ctx.fill();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(time * 0.08);
    for (var t = 0; t < 96; t++) {
      var major = t % 8 === 0;
      ctx.rotate((Math.PI * 2) / 96);
      ctx.strokeStyle = major ? 'rgba(245, 201, 122, 0.72)' : 'rgba(94, 234, 212, 0.32)';
      ctx.lineWidth = major ? 1.4 : 0.6;
      ctx.beginPath();
      ctx.moveTo(R * (major ? 0.78 : 0.86), 0);
      ctx.lineTo(R * 0.96, 0);
      ctx.stroke();
    }
    ctx.restore();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-time * 0.22);
    ctx.strokeStyle = 'rgba(158, 240, 255, 0.28)';
    ctx.lineWidth = 1;
    for (var s = 0; s < 18; s++) {
      ctx.rotate(Math.PI / 9);
      ctx.beginPath();
      ctx.moveTo(R * 0.2, 0);
      ctx.lineTo(R * 0.7, 0);
      ctx.stroke();
    }
    ctx.restore();
    var arcs = [
      { r: 0.96, span: 0.55, speed: 0.85, color: 'rgba(94,234,212,0.95)', width: 2.4, gap: 0.9 },
      { r: 0.86, span: 1.15, speed: -0.55, color: 'rgba(210,255,250,0.8)', width: 1.5, gap: 1.35 },
      { r: 0.74, span: 0.42, speed: 1.25, color: 'rgba(245,201,122,0.9)', width: 2, gap: 0.72 },
      { r: 0.63, span: 1.8, speed: -0.95, color: 'rgba(94,234,212,0.7)', width: 3.2, gap: 2.2 },
      { r: 0.5, span: 0.7, speed: 1.6, color: 'rgba(255,255,255,0.75)', width: 1.2, gap: 1.05 }
    ];
    arcs.forEach(function (arc, n) {
      ctx.strokeStyle = arc.color;
      ctx.lineWidth = arc.width;
      var a0 = time * arc.speed + n * 0.4;
      for (var k = 0; k < 3; k++) {
        ctx.beginPath();
        var start = a0 + k * (arc.span + arc.gap);
        ctx.arc(cx, cy, R * arc.r, start, start + arc.span);
        ctx.stroke();
      }
    });
    var amp = 6 + level * R * 0.22 + Math.sin(time * 2.2) * 4;
    ctx.beginPath();
    for (var i = 0; i <= 96; i++) {
      var ang = (i / 96) * 6.28318;
      var wave = Math.sin(ang * 7 - time * 3.4) * amp;
      var rr = R * 0.36 + wave;
      var x = cx + Math.cos(ang) * rr;
      var y = cy + Math.sin(ang) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(210, 255, 250, 0.85)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    dots.forEach(function (d) {
      var ang = d.a + time * d.s * (state === 'speaking' ? 2.4 : 1);
      var rr = R * d.r;
      ctx.fillStyle = 'rgba(226, 255, 250, 0.9)';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr * 0.92, d.w, 0, 6.28);
      ctx.fill();
    });
    var nucleus = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.16);
    nucleus.addColorStop(0, '#f4fffd');
    nucleus.addColorStop(0.45, 'rgba(94,234,212,0.85)');
    nucleus.addColorStop(1, 'rgba(94,234,212,0)');
    ctx.fillStyle = nucleus;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.16, 0, 6.28);
    ctx.fill();
  }

  function loopParticles(canvas) {
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    function frame(now) {
      fieldTime = (now || 0) / 1000;
      paintField(ctx, canvas.width, canvas.height, reduced ? 0.8 : fieldTime, micLevel);
      if (reduced || hiddenPause || batteryPause || !particlesOn) { raf = 0; return; }
      raf = requestAnimationFrame(frame);
    }
    if (reduced || hiddenPause || batteryPause) { paintField(ctx, canvas.width, canvas.height, 0.8, 0); return; }
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
        micLevel = Math.min(1, Math.sqrt(sum / data.length) * 4);
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

  function markSpeaking(on) {
    if (on) setState('speaking', 'A local chat message was sent. The motion is not an assistant voice.');
    else if (!stream) setState('idle', 'Rings move on their own. The microphone is off. This is not a voice assistant and nothing is recorded.');
    else setState('listening', 'Level follows this browser microphone only. Nothing is recorded, uploaded, or sent to a voice assistant.');
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

  root.HQPresence = { release: release, markSpeaking: markSpeaking, boot: boot, getState: function () { return state; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
