(function () {
  'use strict';

  const A = window.DPIA;
  const $ = (id) => document.getElementById(id);
  const canvas = $('view');
  const ctx = canvas.getContext('2d');

  const HFOV = 103;                       // horizontal field of view, degrees
  const LEVELS = [0.6, 0.78, 1, 1.28, 1.65];
  const LENGTHS = {
    quick:    { passes: 1, flicks: 8,  trackSec: 6 },
    standard: { passes: 1, flicks: 12, trackSec: 8 },
    thorough: { passes: 2, flicks: 12, trackSec: 8 },
  };
  const WARMUP = { flicks: 8, trackSec: 5 };
  // Degrees of yaw per mouse count at sensitivity 1.
  const GAMES = {
    cs2:      { name: 'Counter-Strike 2', yaw: 0.022,  dec: 2 },
    valorant: { name: 'Valorant',         yaw: 0.07,   dec: 3 },
    apex:     { name: 'Apex Legends',     yaw: 0.022,  dec: 2 },
    ow2:      { name: 'Overwatch 2',      yaw: 0.0066, dec: 2 },
    cod:      { name: 'Call of Duty',     yaw: 0.0066, dec: 2 },
  };
  const FLICK_TIMEOUT = 5000;
  const TRACK_RADIUS = 2.0;
  const D2R = Math.PI / 180;

  // ---------- state ----------
  let cfg = null;          // user setup
  let blocks = [];         // [{m, warmup}]
  let bi = 0;              // current block index
  let phase = 'idle';      // idle | wait | flick | gap | trackReady | track | done
  let yaw = 0, pitch = 0;  // camera, degrees
  let degPerCount = 0.05;  // for the current block
  let rawInput = null;     // true / false / null(unknown)
  let skipNextMove = false;
  let locked = false;
  let paused = false;

  let target = null;       // {yaw, pitch, radius}
  let trial = null;        // current flick trial
  let blockFlicks = [];    // finished flick trials in this block
  let blockCenter = { yaw: 0, pitch: 0 };
  let phaseT = 0;          // phase start time
  let track = null;        // {frames, vy, vp, nextTurn, t0}
  let flash = 0;
  const results = {};      // m -> {flicks:[], tracks:[]}

  // ---------- setup form ----------
  const gameSel = $('in-game');
  function syncGameFields() {
    const g = gameSel.value;
    $('f-sens').hidden = !(g in GAMES);
    $('f-cm').hidden = g !== 'custom';
  }
  gameSel.addEventListener('change', syncGameFields);
  syncGameFields();

  const support = $('support-msg');
  if (!('requestPointerLock' in canvas)) {
    support.hidden = false;
    support.textContent = 'This browser does not support pointer lock. Please use a desktop browser such as Chrome, Edge or Firefox with a mouse.';
  } else if (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches) {
    support.hidden = false;
    support.textContent = 'This test needs a mouse. It will not work on a touch screen.';
  }

  function screenWidthPx() {
    return Math.round(screen.width * (window.devicePixelRatio || 1));
  }

  /** cm per 360° for the user's current setup. */
  function baseCm360(c) {
    if (c.game in GAMES) return (360 / (GAMES[c.game].yaw * c.sens) / c.dpi) * 2.54;
    if (c.game === 'custom') return c.cm360;
    // Desktop: one count moves one pixel, and the screen width spans the FOV.
    const degPerCount = HFOV / screenWidthPx();
    return (360 / degPerCount / c.dpi) * 2.54;
  }

  $('setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const dpi = parseFloat($('in-dpi').value);
    const game = gameSel.value;
    const sens = parseFloat($('in-sens').value);
    const cm360 = parseFloat($('in-cm').value);
    if (!(dpi > 0)) return;
    if (game in GAMES && !(sens > 0)) return;
    if (game === 'custom' && !(cm360 > 0)) return;
    const len = document.querySelector('input[name=len]:checked').value;
    cfg = { dpi, game, sens, cm360, len, ...LENGTHS[len] };
    cfg.base = baseCm360(cfg);
    start();
  });

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function start() {
    blocks = [{ m: 1, warmup: true }];
    let prev = null;
    for (let p = 0; p < cfg.passes; p++) {
      let order;
      do { order = shuffle([...LEVELS]); } while (order[0] === prev);
      order.forEach((m) => blocks.push({ m, warmup: false }));
      prev = order[order.length - 1];
    }
    LEVELS.forEach((m) => { results[m] = { flicks: [], tracks: [] }; });
    bi = 0;
    yaw = 0; pitch = 0;
    $('setup').hidden = true;
    $('results').hidden = true;
    beginBlock();
    showOverlay('Ready?', 'Your mouse will be captured for the test. First a short warm-up at your current sensitivity. Press Esc anytime to pause.', 'Start warm-up');
  }

  // ---------- pointer lock ----------
  async function lock() {
    try {
      const p = canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.then === 'function') { await p; rawInput = true; }
      else if (rawInput !== true) rawInput = null;
    } catch (err) {
      if (err && err.name === 'NotSupportedError') {
        rawInput = false;
        try { await canvas.requestPointerLock(); } catch (e2) { lockFailed(); }
      } else {
        lockFailed();
      }
    }
  }
  function lockFailed() {
    showOverlay('Paused', 'The browser needs a moment before capturing the mouse again. Click Continue once more.', 'Continue');
  }

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (locked) {
      skipNextMove = true;
      paused = false;
      $('overlay').hidden = true;
      $('hud').hidden = false;
      if (phase === 'idle') startFlicks();
      else resumePhase();
    } else if (phase !== 'done' && phase !== 'idle') {
      pause();
    }
  });

  function pause() {
    paused = true;
    // Drop the half-finished target or tracking run; it gets replayed.
    trial = null;
    if (phase === 'track' || phase === 'trackReady') phase = 'trackPending';
    else if (phase === 'flick' || phase === 'gap') phase = 'flickPending';
    showOverlay('Paused', 'Your progress is kept. The interrupted target will be replayed.', 'Continue');
  }

  function resumePhase() {
    if (phase === 'flickPending') { phase = 'flick'; spawnFlick(); }
    else if (phase === 'trackPending') startTracking();
  }

  function showOverlay(title, body, btn) {
    $('ov-title').textContent = title;
    $('ov-body').textContent = body;
    $('ov-btn').textContent = btn;
    $('overlay').hidden = false;
    $('hud').hidden = true;
  }
  $('ov-btn').addEventListener('click', () => lock());
  $('ov-quit').addEventListener('click', () => {
    phase = 'idle';
    $('overlay').hidden = true;
    $('hud').hidden = true;
    $('setup').hidden = false;
  });

  // ---------- blocks and phases ----------
  function beginBlock() {
    const b = blocks[bi];
    degPerCount = (360 / ((cfg.base / 2.54) * cfg.dpi)) * b.m;
    blockFlicks = [];
    phase = 'idle';
  }

  function block() { return blocks[bi]; }
  function flickCount() { return block().warmup ? WARMUP.flicks : cfg.flicks; }
  function trackSec() { return block().warmup ? WARMUP.trackSec : cfg.trackSec; }

  function startFlicks() {
    blockCenter = { yaw, pitch };
    phase = 'flick';
    spawnFlick();
  }

  function spawnFlick() {
    const now = performance.now();
    const c = Math.cos(pitch * D2R);
    let tyaw, tp;
    do {
      const D = 10 + Math.random() * 40;
      let th = Math.random() * Math.PI * 2;
      // Pull back towards the start so the mouse doesn't walk off the pad.
      const off = yaw - blockCenter.yaw;
      if (Math.abs(off) > 25 && Math.sign(Math.cos(th)) === Math.sign(off)) th = Math.PI - th;
      tyaw = yaw + D * Math.cos(th);
      tp = Math.max(-28, Math.min(28, pitch + D * Math.sin(th) * 0.55));
    } while (Math.hypot((tyaw - yaw) * c, tp - pitch) < 8);
    const radius = blockFlicks.length % 2 ? 2.2 : 1.4;
    target = { yaw: tyaw, pitch: tp, radius };
    trial = {
      startT: now, endT: null, hitT: null, missClicks: 0, radius,
      yaw0: yaw, pitch0: pitch, cos0: c,
      tx: (tyaw - yaw) * c, ty: tp - pitch,
      samples: [],
    };
  }

  function finishFlick(hit) {
    const now = performance.now();
    if (hit) trial.hitT = now; else trial.endT = now;
    blockFlicks.push(trial);
    trial = null;
    target = null;
    if (hit) flash = now;
    if (blockFlicks.length >= flickCount()) {
      startTracking();
    } else {
      phase = 'gap';
      phaseT = now;
    }
  }

  function startTracking() {
    phase = 'trackReady';
    phaseT = performance.now();
    blockCenter = { yaw, pitch };
    target = { yaw: yaw + 4, pitch, radius: TRACK_RADIUS };
    track = { frames: [], vy: 0, vp: 0, nextTurn: 0, t0: 0, phaseP: Math.random() * 6 };
  }

  function finishBlock() {
    const b = block();
    if (!b.warmup) {
      results[b.m].flicks.push(...blockFlicks);
      results[b.m].tracks.push(track.frames);
    }
    target = null;
    bi++;
    if (bi >= blocks.length) { finishTest(); return; }
    beginBlock();
    phase = 'wait';
  }

  // ---------- input ----------
  canvas.addEventListener('mousemove', (e) => {
    if (!locked || paused) return;
    if (skipNextMove) { skipNextMove = false; return; }
    const dx = e.movementX, dy = e.movementY;
    if (Math.abs(dx) > 4000 || Math.abs(dy) > 4000) return; // spurious spike
    yaw += dx * degPerCount;
    pitch = Math.max(-85, Math.min(85, pitch - dy * degPerCount));
    if (trial) {
      trial.samples.push({ t: performance.now(), x: (yaw - trial.yaw0) * trial.cos0, y: pitch - trial.pitch0 });
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    if (!locked || paused || e.button !== 0) return;
    if (phase === 'wait') { startFlicks(); return; }
    if (phase === 'flick' && target && trial) {
      if (angleTo(target) <= target.radius) finishFlick(true);
      else trial.missClicks++;
    }
  });

  // ---------- geometry ----------
  function dir(yd, pd) {
    const y = yd * D2R, p = pd * D2R;
    return [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
  }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  function angleTo(t) {
    return Math.acos(Math.max(-1, Math.min(1, dot(dir(t.yaw, t.pitch), dir(yaw, pitch))))) / D2R;
  }
  function basis() {
    const f = dir(yaw, pitch);
    const y = yaw * D2R;
    const r = [Math.cos(y), 0, -Math.sin(y)];
    const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
    return { f, r, u };
  }

  // ---------- loop ----------
  let W = 0, H = 0, F = 1, dpr = 1;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    F = (W / 2) / Math.tan((HFOV / 2) * D2R);
  }
  window.addEventListener('resize', resize);
  resize();

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(50, now - last);
    last = now;
    update(now, dt);
    draw(now);
    requestAnimationFrame(frame);
  }

  function update(now, dt) {
    if (!locked || paused) return;
    if (phase === 'gap' && now - phaseT > 220) { phase = 'flick'; spawnFlick(); }
    if (phase === 'flick' && trial && now - trial.startT > FLICK_TIMEOUT) finishFlick(false);

    if (phase === 'trackReady') {
      if (now - phaseT > 1200) { phase = 'track'; track.t0 = now; track.nextTurn = now; }
    } else if (phase === 'track') {
      if (now >= track.nextTurn) {
        let s = (30 + Math.random() * 40) * (Math.random() < 0.5 ? -1 : 1);
        const off = target.yaw - blockCenter.yaw;
        if (Math.abs(off) > 30) s = -Math.sign(off) * Math.abs(s);
        track.vy = s;
        track.nextTurn = now + 350 + Math.random() * 650;
      }
      const el = (now - track.t0) / 1000;
      target.yaw += track.vy * dt / 1000;
      target.pitch = blockCenter.pitch + 4 * Math.sin(el * 2.7 + track.phaseP);
      const err = angleTo(target);
      const lead = Math.sign(track.vy) * (yaw - target.yaw) * Math.cos(pitch * D2R);
      track.frames.push({ dt, err, on: err <= target.radius, lead });
      if (el >= trackSec()) finishBlock();
    }
    updateHud(now);
  }

  function updateHud(now) {
    const b = block();
    if (!b) return;
    const rounds = blocks.length - 1;
    $('hud-round').textContent = b.warmup ? 'Warm-up' : `Round ${bi} of ${rounds}`;
    if (phase === 'flick' || phase === 'gap') {
      $('hud-task').textContent = 'Flick: click the targets';
      $('hud-progress').textContent = `${blockFlicks.length} / ${flickCount()}`;
    } else if (phase === 'trackReady') {
      $('hud-task').textContent = 'Tracking: stay on the target';
      $('hud-progress').textContent = 'get ready';
    } else if (phase === 'track') {
      $('hud-task').textContent = 'Tracking: stay on the target';
      $('hud-progress').textContent = Math.max(0, trackSec() - (now - track.t0) / 1000).toFixed(1) + 's';
    } else if (phase === 'wait') {
      $('hud-task').textContent = 'Click to start';
      $('hud-progress').textContent = '';
    }
  }

  function project(B, yd, pd) {
    const d = dir(yd, pd);
    const cz = dot(d, B.f);
    if (cz < 0.05) return null;
    return { x: W / 2 + (dot(d, B.r) / cz) * F, y: H / 2 - (dot(d, B.u) / cz) * F, z: cz };
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0d1520'); g.addColorStop(1, '#090d12');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const B = basis();
    // Reference dots on a sphere so rotation is visible.
    for (let p = -60; p <= 60; p += 10) {
      for (let y = Math.floor((yaw - 90) / 10) * 10; y <= yaw + 90; y += 10) {
        const s = project(B, y, p);
        if (!s) continue;
        const major = p === 0 || ((y % 30) + 30) % 30 === 0;
        ctx.fillStyle = p === 0 ? 'rgba(34,211,238,.35)' : major ? 'rgba(170,190,210,.22)' : 'rgba(170,190,210,.1)';
        const r = (p === 0 ? 2.2 : 1.6) * Math.min(1.6, s.z + 0.3);
        ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
      }
    }

    if (target && phase !== 'idle') {
      const s = project(B, target.yaw, target.pitch);
      if (s) {
        const r = Math.max(3, (Math.tan(target.radius * D2R) / s.z) * F);
        const on = angleTo(target) <= target.radius;
        const tracking = phase === 'track' || phase === 'trackReady';
        const grad = ctx.createRadialGradient(s.x - r * 0.35, s.y - r * 0.35, r * 0.1, s.x, s.y, r);
        if (tracking && on) { grad.addColorStop(0, '#a7f3d0'); grad.addColorStop(1, '#059669'); }
        else { grad.addColorStop(0, '#fdba74'); grad.addColorStop(1, '#c2410c'); }
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
      } else {
        // Off-screen: arrow at the edge.
        const d = dir(target.yaw, target.pitch);
        const ang = Math.atan2(-dot(d, B.u), dot(d, B.r));
        const R = Math.min(W, H) * 0.42;
        const x = W / 2 + Math.cos(ang) * R, y = H / 2 + Math.sin(ang) * R;
        ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
        ctx.fillStyle = 'rgba(249,115,22,.85)';
        ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-8, -9); ctx.lineTo(-8, 9); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }

    if (phase === 'wait' && locked && !paused) {
      ctx.fillStyle = 'rgba(230,237,245,.92)';
      ctx.font = '600 22px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const doneRound = bi - 1;
      ctx.fillText(doneRound === 0 ? 'Warm-up done' : `Round ${doneRound} done`, W / 2, H / 2 - 60);
      ctx.font = '15px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(169,182,198,.95)';
      ctx.fillText('Sensitivity changes each round. Click to start the next one.', W / 2, H / 2 - 34);
    }

    // Crosshair
    const hit = now - flash < 120;
    ctx.strokeStyle = hit ? '#34d399' : '#22d3ee';
    ctx.lineWidth = 2;
    const cx = W / 2, cy = H / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 9, cy); ctx.lineTo(cx - 3, cy);
    ctx.moveTo(cx + 3, cy); ctx.lineTo(cx + 9, cy);
    ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy - 3);
    ctx.moveTo(cx, cy + 3); ctx.lineTo(cx, cy + 9);
    ctx.stroke();
  }
  requestAnimationFrame(frame);

  // ---------- results ----------
  function finishTest() {
    phase = 'done';
    target = null;
    if (document.pointerLockElement) document.exitPointerLock();
    $('hud').hidden = true;
    const levels = LEVELS.map((m) => A.summarizeLevel(m, results[m].flicks, results[m].tracks));
    const rec = A.recommend(levels);
    renderResults(rec);
  }

  const round50 = (v) => Math.max(50, Math.round(v / 50) * 50);
  const fmt = (v, d) => Number(v.toFixed(d)).toString();

  function buildRecommendation(rec) {
    const m = rec.multiplier;
    const cm = cfg.base / m;
    const out = { m, cm360: cm, dpi: round50(cfg.dpi * m) };
    if (cfg.game in GAMES) {
      const gm = GAMES[cfg.game];
      out.edpi = cfg.dpi * cfg.sens * m;
      out.sensSameDpi = cfg.sens * m;
      // Exact eDPI with the rounded DPI: nudge sensitivity to absorb the rounding.
      out.sensAtRecDpi = out.edpi / out.dpi;
      const std = [400, 800, 1600, 3200].reduce((p, q) => (Math.abs(Math.log(q / (cfg.dpi * m))) < Math.abs(Math.log(p / (cfg.dpi * m))) ? q : p));
      out.std = { dpi: std, sens: out.edpi / std };
      out.dec = gm.dec;
    }
    return out;
  }

  let lastText = '';
  function renderResults(rec) {
    const r = buildRecommendation(rec);
    const change = Math.round((r.m - 1) * 100);
    const changeTxt = Math.abs(change) < 3 ? 'about the same as now' : `${Math.abs(change)}% ${change > 0 ? 'faster' : 'slower'} than now`;
    const g = GAMES[cfg.game];
    let html = '<div class="rec-hero">';
    html += `<div class="stat main"><div class="k">Recommended DPI</div><div class="v">${r.dpi}</div><div class="s">now ${cfg.dpi}, ${changeTxt}</div></div>`;
    if (g) {
      html += `<div class="stat"><div class="k">eDPI (${g.name})</div><div class="v">${Math.round(r.edpi)}</div><div class="s">now ${Math.round(cfg.dpi * cfg.sens)}</div></div>`;
    }
    if (cfg.game !== 'none') {
      html += `<div class="stat"><div class="k">cm per 360°</div><div class="v">${fmt(r.cm360, 1)}</div><div class="s">now ${fmt(cfg.base, 1)}</div></div>`;
    } else {
      const inch = screenWidthPx() / r.dpi;
      html += `<div class="stat"><div class="k">Hand travel across screen</div><div class="v">${fmt(inch * 2.54, 1)} cm</div><div class="s">now ${fmt((screenWidthPx() / cfg.dpi) * 2.54, 1)} cm</div></div>`;
    }
    html += '</div>';
    if (g) {
      html += `<p class="rec-alt">Set your mouse to <b>${r.dpi} DPI</b> with ${g.name} sensitivity <b>${fmt(r.sensAtRecDpi, r.dec)}</b>. Or keep ${cfg.dpi} DPI and change sensitivity to <b>${fmt(r.sensSameDpi, r.dec)}</b>.`;
      if (r.std.dpi !== r.dpi) html += ` If your mouse only has standard steps, use <b>${r.std.dpi} DPI</b> at <b>${fmt(r.std.sens, r.dec)}</b>.`;
      html += '</p>';
    } else {
      html += `<p class="rec-alt">Set your mouse to <b>${r.dpi} DPI</b> and keep Windows pointer speed at the default (6 of 11) with acceleration off. Most mouse software accepts steps of 50.</p>`;
    }
    html += `<span class="confidence">Confidence: ${rec.confidence}</span><p class="fine" style="margin-top:6px">${rec.reason}</p>`;
    $('rec').innerHTML = html;

    $('insights').innerHTML = A.insights(rec).map((t) => `<li>${t}</li>`).join('');
    renderChart(rec);
    renderTable(rec);

    const notes = [];
    if (rawInput === true) notes.push('Raw mouse input was used, so OS acceleration and pointer speed did not affect the test.');
    else notes.push('Raw mouse input was not available in this browser, so the test assumes Windows pointer speed 6/11 with acceleration off. Chrome or Edge give the most accurate result.');
    notes.push('Results reflect one session. Repeat on another day and average if you want extra certainty.');
    $('input-note').textContent = notes.join(' ');

    lastText = `DPI Finder: recommended ${r.dpi} DPI (from ${cfg.dpi})` +
      (g ? `, ${g.name} sens ${fmt(r.sensAtRecDpi, r.dec)}, eDPI ${Math.round(r.edpi)}` : '') +
      (cfg.game !== 'none' ? `, ${fmt(r.cm360, 1)} cm/360` : '') + `. Confidence ${rec.confidence}.`;
    $('results').hidden = false;
  }

  function renderTable(rec) {
    const best = rec.levels.reduce((p, q) => (q.score > p.score ? q : p));
    const head = ['Sensitivity', 'cm/360', 'Score', 'Flick time', 'Accuracy', 'Overshoot', 'Undershoot', 'Corrections', 'On target'];
    const rows = rec.levels.map((l) => `<tr class="${l === best ? 'is-best' : ''}">` + [
      `${Math.round(l.m * 100)}%`,
      fmt(cfg.base / l.m, 1),
      Math.round(l.score * 100),
      isNaN(l.medianTimeMs) ? '–' : Math.round(l.medianTimeMs) + ' ms',
      Math.round(l.accuracy * 100) + '%',
      Math.round(l.overshootRate * 100) + '%',
      Math.round(l.undershootRate * 100) + '%',
      l.corrections.toFixed(1),
      Math.round(l.onTarget * 100) + '%',
    ].map((v) => `<td>${v}</td>`).join('') + '</tr>');
    $('table').innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody>`;
  }

  function renderChart(rec) {
    const w = 680, h = 260, L = 44, R = 16, T = 26, Bm = 42;
    const ls = rec.levels;
    const x0 = Math.log(ls[0].m), x1 = Math.log(ls[ls.length - 1].m);
    const ys = ls.map((l) => l.score);
    const ymin = Math.max(0, Math.floor((Math.min(...ys) - 0.08) * 10) / 10), ymax = 1.0;
    const sx = (lm) => L + ((lm - x0) / (x1 - x0)) * (w - L - R);
    const sy = (v) => T + (1 - (v - ymin) / (ymax - ymin)) * (h - T - Bm);
    let s = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Score at each tested sensitivity">`;
    s += '<g class="grid">';
    for (let v = ymin; v <= ymax + 1e-9; v += 0.1) s += `<line x1="${L}" x2="${w - R}" y1="${sy(v)}" y2="${sy(v)}"/>`;
    s += '</g><g class="axis">';
    for (let v = ymin; v <= ymax + 1e-9; v += 0.2) s += `<text x="${L - 8}" y="${sy(v) + 4}" text-anchor="end">${Math.round(v * 100)}</text>`;
    ls.forEach((l) => {
      s += `<text x="${sx(Math.log(l.m))}" y="${h - Bm + 18}" text-anchor="middle">${cfg.game === 'none' ? Math.round(l.m * 100) + '%' : fmt(cfg.base / l.m, 1)}</text>`;
    });
    s += `<text class="axis-title" x="${(L + w - R) / 2}" y="${h - 6}" text-anchor="middle">${cfg.game === 'none' ? 'Speed vs your current setting (slower ← → faster)' : 'cm per 360° (slower ← → faster)'}</text>`;
    s += '</g>';
    if (rec.fit && rec.fit.a < 0) {
      let d = '';
      for (let i = 0; i <= 60; i++) {
        const x = x0 + (i / 60) * (x1 - x0);
        const y = rec.fit.a * x * x + rec.fit.b * x + rec.fit.c;
        d += (i ? 'L' : 'M') + sx(x).toFixed(1) + ',' + sy(Math.max(ymin, Math.min(ymax, y))).toFixed(1);
      }
      s += `<path class="fit" d="${d}"/>`;
    }
    s += `<path class="series" d="${ls.map((l, i) => (i ? 'L' : 'M') + sx(Math.log(l.m)) + ',' + sy(l.score)).join('')}"/>`;
    const bx = sx(Math.log(rec.multiplier));
    const by = rec.fit && rec.fit.a < 0 && rec.method === 'curve-peak'
      ? sy(Math.min(ymax, rec.fit.a * Math.log(rec.multiplier) ** 2 + rec.fit.b * Math.log(rec.multiplier) + rec.fit.c))
      : sy(Math.max(...ys));
    s += `<g class="best"><line x1="${bx}" x2="${bx}" y1="${T - 6}" y2="${h - Bm}"/><circle cx="${bx}" cy="${by}" r="5"/><text x="${bx}" y="${T - 10}" text-anchor="middle">Best</text></g>`;
    ls.forEach((l, i) => {
      s += `<circle class="pt" cx="${sx(Math.log(l.m))}" cy="${sy(l.score)}" r="5"/>`;
      s += `<circle class="hit" data-i="${i}" cx="${sx(Math.log(l.m))}" cy="${sy(l.score)}" r="16"/>`;
    });
    s += '</svg><div class="tooltip" hidden></div>';
    const el = $('chart');
    el.innerHTML = s;
    const tip = el.querySelector('.tooltip');
    el.querySelectorAll('.hit').forEach((c) => {
      c.addEventListener('mouseenter', () => {
        const l = ls[+c.dataset.i];
        const svg = el.querySelector('svg');
        const k = svg.getBoundingClientRect().width / w;
        tip.innerHTML = `<b>Score ${Math.round(l.score * 100)}</b> <span class="m">· ${cfg.game === 'none' ? Math.round(l.m * 100) + '% speed' : fmt(cfg.base / l.m, 1) + ' cm/360'}</span><br><span class="m">Flick ${Math.round(l.flickScore * 100)} · Tracking ${Math.round(l.trackScore * 100)}</span>`;
        tip.style.left = (+c.getAttribute('cx') * k) + 'px';
        tip.style.top = (+c.getAttribute('cy') * k) + 'px';
        tip.hidden = false;
      });
      c.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
  }

  $('btn-again').addEventListener('click', () => {
    $('results').hidden = true;
    $('setup').hidden = false;
    phase = 'idle';
  });
  $('btn-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lastText); $('btn-copy').textContent = 'Copied'; }
    catch (e) { $('btn-copy').textContent = 'Copy failed'; }
    setTimeout(() => { $('btn-copy').textContent = 'Copy result'; }, 1500);
  });

  // Exposed for automated testing only.
  window.__dpi = { get state() { return { phase, bi, blocks, yaw, pitch, target, degPerCount, locked }; }, results, finishTest, LEVELS };
})();
