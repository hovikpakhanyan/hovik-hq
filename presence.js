(function (root) {
  var state = 'idle';
  var reason = 'Rings move on their own. The microphone is off. This is not a voice assistant and nothing is recorded.';
  var stream = null;
  var audioCtx = null;
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
    var btn = document.getElementById('presence-mic');
    if (core) core.setAttribute('data-presence', state);
    if (label) label.textContent = state === 'listening' ? 'Listening locally'
      : state === 'speaking' ? 'Local message'
      : state === 'disconnected' ? 'Microphone off'
      : 'Idle';
    if (noteEl) noteEl.textContent = reason;
    if (btn) btn.textContent = stream ? 'Stop microphone' : 'Use microphone';
  }

  function release(why) {
    if (stream) {
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      stream = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(function () {});
      audioCtx = null;
    }
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
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.46;
    var wash = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R);
    wash.addColorStop(0, 'rgba(190, 255, 244, 0.55)');
    wash.addColorStop(0.18, 'rgba(94, 234, 212, 0.18)');
    wash.addColorStop(1, 'rgba(94, 234, 212, 0)');
    ctx.fillStyle = wash;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 6.28);
    ctx.fill();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(time * 0.15);
    ctx.strokeStyle = 'rgba(245, 201, 122, 0.35)';
    ctx.lineWidth = 1;
    for (var s = 0; s < 12; s++) {
      ctx.rotate(Math.PI / 6);
      ctx.beginPath();
      ctx.moveTo(R * 0.16, 0);
      ctx.lineTo(R * 0.92, 0);
      ctx.stroke();
    }
    ctx.restore();
    var arcs = [
      { r: 0.9, span: 1.4, speed: 0.7, color: 'rgba(94,234,212,0.9)', width: 2.2 },
      { r: 0.72, span: 2.1, speed: -0.45, color: 'rgba(158, 240, 255, 0.75)', width: 3 },
      { r: 0.54, span: 0.9, speed: 1.1, color: 'rgba(245,201,122,0.8)', width: 1.6 }
    ];
    arcs.forEach(function (arc, n) {
      ctx.strokeStyle = arc.color;
      ctx.lineWidth = arc.width;
      ctx.beginPath();
      var a0 = time * arc.speed + n;
      ctx.arc(cx, cy, R * arc.r, a0, a0 + arc.span);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, R * arc.r, a0 + 2.4, a0 + 2.4 + arc.span * 0.65);
      ctx.stroke();
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

  async function toggleMic() {
    if (stream) { release('stop'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setState('disconnected', 'This browser has no microphone API. Nothing was recorded.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var src = audioCtx.createMediaStreamSource(stream);
      var analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      var data = new Uint8Array(analyser.fftSize);
      setState('listening', 'Level follows this browser microphone only. Nothing is recorded, uploaded, or sent to a voice assistant.');
      (function pump() {
        if (!stream) return;
        analyser.getByteTimeDomainData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i++) {
          var v = (data[i] - 128) / 128;
          sum += v * v;
        }
        micLevel = Math.min(1, Math.sqrt(sum / data.length) * 4);
        if (stream) requestAnimationFrame(pump);
      })();
      stream.getTracks().forEach(function (t) {
        t.addEventListener('ended', function () { release('error'); });
      });
    } catch (err) {
      stream = null;
      var name = err && err.name;
      var msg = name === 'NotAllowedError' ? 'Microphone permission was denied. Nothing was recorded.'
        : name === 'NotFoundError' ? 'No microphone was found.'
        : 'Microphone could not start. Nothing was recorded or sent.';
      setState('disconnected', msg);
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
        if (stream) release('hidden');
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
    var btn = document.getElementById('presence-mic');
    if (btn) btn.addEventListener('click', toggleMic);
    setState('idle');
    startField();
  }

  root.HQPresence = { release: release, markSpeaking: markSpeaking, boot: boot, getState: function () { return state; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
