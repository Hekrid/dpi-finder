/*
 * Movement analysis and DPI recommendation.
 * Pure functions, no DOM, so they can be unit tested in Node.
 *
 * Coordinates are degrees of view rotation. A flick trial stores its samples
 * in a local frame centred on where the crosshair was when the target spawned.
 */
(function (root) {
  'use strict';

  const STEP_MS = 4;          // resample interval
  const SMOOTH = 5;           // moving-average window (samples) for speed

  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  const median = (a) => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  /** Fitts' index of difficulty in bits. */
  function fittsID(dist, radius) {
    return Math.log2(dist / (2 * radius) + 1);
  }

  /** Sample-and-hold resample of irregular {t,x,y} samples onto a fixed step. */
  function resample(samples, endT) {
    if (!samples.length) return [];
    const out = [];
    const t0 = samples[0].t;
    const t1 = endT != null ? endT : samples[samples.length - 1].t;
    let j = 0;
    for (let t = t0; t <= t1 + 1e-9; t += STEP_MS) {
      while (j < samples.length - 1 && samples[j + 1].t <= t) j++;
      // Mouse position is a step function between events: hold the last value.
      const p = samples[j];
      out.push({ t, x: p.x, y: p.y });
    }
    return out;
  }

  /**
   * Analyse one flick trial.
   * trial: { tx, ty, radius, samples:[{t,x,y}], startT, hitT|null, missClicks }
   */
  function analyzeFlick(trial) {
    const D = Math.hypot(trial.tx, trial.ty);
    const ux = trial.tx / D, uy = trial.ty / D;
    const end = trial.hitT != null ? trial.hitT : trial.endT;
    const pts = resample([{ t: trial.startT, x: 0, y: 0 }, ...trial.samples.filter((s) => s.t >= trial.startT && s.t <= end)], end);

    const prog = pts.map((p) => p.x * ux + p.y * uy);
    const raw = [0];
    for (let i = 1; i < pts.length; i++) {
      raw.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / (STEP_MS / 1000));
    }
    const speed = raw.map((_, i) => {
      const lo = Math.max(0, i - (SMOOTH >> 1));
      const hi = Math.min(raw.length, i + (SMOOTH >> 1) + 1);
      let s = 0;
      for (let k = lo; k < hi; k++) s += raw[k];
      return s / (hi - lo);
    });

    let peak = 0, ip = 0;
    speed.forEach((v, i) => { if (v > peak) { peak = v; ip = i; } });

    // End of the primary (ballistic) submovement: speed falls below 15% of peak.
    let j = ip;
    while (j < speed.length - 1 && speed[j] > 0.15 * peak) j++;
    const firstEnd = prog[j] != null ? prog[j] : 0;

    // Corrective submovements after that, with hysteresis.
    let corrections = 0;
    let moving = false;
    const rise = Math.max(0.2 * peak, 8), fall = Math.max(0.1 * peak, 4);
    for (let i = j + 1; i < speed.length; i++) {
      if (!moving && speed[i] > rise) { moving = true; corrections++; }
      else if (moving && speed[i] < fall) moving = false;
    }

    const maxProg = prog.length ? Math.max(...prog) : 0;
    const r = trial.radius;
    return {
      hit: trial.hitT != null,
      timeMs: trial.hitT != null ? trial.hitT - trial.startT : null,
      dist: D,
      radius: r,
      id: fittsID(D, r),
      missClicks: trial.missClicks || 0,
      peakSpeed: peak,
      overshoot: maxProg > D + r,
      overshootPct: Math.max(0, (maxProg - D) / D),
      undershoot: firstEnd < D - r,
      firstEndPct: firstEnd / D,
      corrections,
    };
  }

  /**
   * Summarise a tracking run.
   * frames: [{dt, err, on, lead}] where err is angular error (deg), lead is the
   * signed horizontal error along the target's motion (+ = crosshair ahead).
   */
  function analyzeTracking(frames) {
    let tot = 0, on = 0, err = 0, lead = 0;
    for (const f of frames) {
      tot += f.dt;
      if (f.on) on += f.dt;
      err += f.err * f.dt;
      lead += f.lead * f.dt;
    }
    if (!tot) return { onTarget: 0, meanErr: NaN, lead: 0, seconds: 0 };
    return { onTarget: on / tot, meanErr: err / tot, lead: lead / tot, seconds: tot / 1000 };
  }

  /** Split a tracking run into ~1 s chunks so they can be resampled. */
  function trackChunks(frames, ms = 1000) {
    const out = [];
    let cur = [], acc = 0;
    for (const f of frames) {
      cur.push(f);
      acc += f.dt;
      if (acc >= ms) { out.push(analyzeTracking(cur)); cur = []; acc = 0; }
    }
    if (acc >= ms / 2) out.push(analyzeTracking(cur));
    return out;
  }

  /** Aggregate all rounds played at one multiplier. */
  function summarizeLevel(m, flicks, tracks) {
    return summarizeStats(m, flicks.map(analyzeFlick), tracks.flatMap((t) => trackChunks(t)));
  }

  /** Same, from already analysed flicks and tracking chunks. */
  function summarizeStats(m, a, t) {
    const hits = a.filter((f) => f.hit);
    const missClicks = a.reduce((s, f) => s + f.missClicks, 0);
    const timeouts = a.length - hits.length;
    const accuracy = hits.length / Math.max(1, hits.length + missClicks + timeouts);
    // Per-trial throughput; median keeps one fumbled target from dominating.
    const tp = median(hits.map((f) => f.id / (f.timeMs / 1000)));
    const secs = t.reduce((s, x) => s + x.seconds, 0) || 1;
    const w = (k) => t.reduce((s, x) => s + x[k] * x.seconds, 0) / secs;
    return {
      m,
      flickStats: a,
      trackStats: t,
      trials: a.length,
      hits: hits.length,
      missClicks,
      timeouts,
      accuracy,
      throughput: isNaN(tp) ? 0 : tp,
      medianTimeMs: median(hits.map((f) => f.timeMs)),
      overshootRate: a.length ? a.filter((f) => f.overshoot).length / a.length : 0,
      undershootRate: a.length ? a.filter((f) => f.undershoot).length / a.length : 0,
      corrections: mean(a.map((f) => f.corrections)) || 0,
      onTarget: t.length ? w('onTarget') : 0,
      trackErr: t.length ? w('meanErr') : NaN,
      trackLead: t.length ? w('lead') : 0,
    };
  }

  /** Small seeded PRNG so results are reproducible for a given run. */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const quantile = (sorted, q) => {
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  };

  /**
   * How much would the answer move if the same person played again?
   * Resample each round's targets and tracking seconds with replacement and
   * redo the whole recommendation. Returns the middle 80% of optima.
   */
  function bootstrap(levels, B = 400, seed = 1) {
    const r = rng(seed);
    const pick = (arr) => { const o = []; for (let i = 0; i < arr.length; i++) o.push(arr[Math.floor(r() * arr.length)]); return o; };
    const xs = [];
    for (let b = 0; b < B; b++) {
      const ls = levels.map((l) => summarizeStats(l.m, pick(l.flickStats), pick(l.trackStats)));
      xs.push(Math.log(recommend(ls).multiplier));
    }
    xs.sort((p, q) => p - q);
    return { lo: Math.exp(quantile(xs, 0.1)), mid: Math.exp(quantile(xs, 0.5)), hi: Math.exp(quantile(xs, 0.9)) };
  }

  /**
   * The verdict shown to the user. Short-term tests favour the sensitivity you
   * already know, and a few dozen targets per round are noisy, so we only say
   * "change" when the whole likely range sits clearly away from the current one.
   */
  const KEEP_WITHIN = 0.07; // +/-7% is below what players can reliably feel or benefit from
  function verdict(levels) {
    const rec = recommend(levels);
    const band = bootstrap(levels);
    const near = (m) => Math.abs(Math.log(m)) <= Math.log(1 + KEEP_WITHIN);
    const keep = (band.lo <= 1 && band.hi >= 1) || near(band.mid);
    const target = keep ? 1 : band.mid;
    return { ...rec, band, keep, multiplier: target, peak: rec.multiplier };
  }

  /** Weighted least squares fit y = a x^2 + b x + c. */
  function fitQuadratic(xs, ys) {
    const n = xs.length;
    let S = [0, 0, 0, 0, 0], T = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const x = xs[i], y = ys[i];
      let p = 1;
      for (let k = 0; k < 5; k++) { S[k] += p; if (k < 3) T[k] += p * y; p *= x; }
    }
    // Normal equations, solved with Cramer's rule.
    const M = [[S[4], S[3], S[2]], [S[3], S[2], S[1]], [S[2], S[1], S[0]]];
    const R = [T[2], T[1], T[0]];
    const det3 = (A) =>
      A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
      A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
      A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    const d = det3(M);
    if (Math.abs(d) < 1e-12) return null;
    const col = (c) => M.map((row, i) => row.map((v, j) => (j === c ? R[i] : v)));
    const a = det3(col(0)) / d, b = det3(col(1)) / d, c = det3(col(2)) / d;
    const my = mean(ys);
    let ssr = 0, sst = 0;
    for (let i = 0; i < n; i++) {
      const f = a * xs[i] * xs[i] + b * xs[i] + c;
      ssr += (ys[i] - f) ** 2;
      sst += (ys[i] - my) ** 2;
    }
    return { a, b, c, r2: sst > 0 ? 1 - ssr / sst : 0 };
  }

  /**
   * Turn per-level summaries into a recommended sensitivity multiplier.
   * Score = 55% flick (throughput x accuracy) + 45% tracking time-on-target,
   * each normalised to the best level, then a quadratic in log(multiplier)
   * finds the peak between the tested points.
   */
  function recommend(levels) {
    const ls = [...levels].sort((p, q) => p.m - q.m);
    const flickRaw = ls.map((l) => l.throughput * l.accuracy);
    const trackRaw = ls.map((l) => l.onTarget);
    const fMax = Math.max(...flickRaw) || 1, tMax = Math.max(...trackRaw) || 1;
    ls.forEach((l, i) => {
      l.flickScore = flickRaw[i] / fMax;
      l.trackScore = trackRaw[i] / tMax;
      l.score = 0.55 * l.flickScore + 0.45 * l.trackScore;
    });

    const xs = ls.map((l) => Math.log(l.m));
    const ys = ls.map((l) => l.score);
    const xmin = xs[0], xmax = xs[xs.length - 1];
    let best = ls.reduce((p, q) => (q.score > p.score ? q : p));
    const fit = fitQuadratic(xs, ys);
    let x = Math.log(best.m);
    let method = 'best-round';
    if (fit && fit.a < 0) {
      const v = -fit.b / (2 * fit.a);
      if (v >= xmin - 0.05 && v <= xmax + 0.05) {
        x = Math.min(xmax, Math.max(xmin, v));
        method = 'curve-peak';
      }
    }
    const mult = Math.exp(x);
    const atEdge = Math.abs(x - xmin) < 0.04 || Math.abs(x - xmax) < 0.04;
    const spread = Math.max(...ys) - Math.min(...ys);

    let confidence = 'medium';
    let reason = '';
    if (atEdge) { confidence = 'low'; reason = 'Your best result was at the edge of the tested range, so the true optimum may be further out. Retest after applying this.'; }
    else if (spread < 0.06) { confidence = 'low'; reason = 'Your performance barely changed between sensitivities, so small changes will not matter much.'; }
    else if (fit && fit.a < 0 && fit.r2 > 0.6) { confidence = 'high'; reason = 'Your scores rose and fell cleanly around a clear peak.'; }
    else { reason = 'There was a peak, but rounds were noisy. A Thorough test will tighten this up.'; }

    return { levels: ls, multiplier: mult, method, fit, atEdge, spread, confidence, reason };
  }

  /** Signals about the user's current setting (multiplier 1). */
  function insights(rec) {
    const out = [];
    const ls = rec.levels;
    const cur = ls.reduce((p, q) => (Math.abs(Math.log(q.m)) < Math.abs(Math.log(p.m)) ? q : p));
    const lo = ls[0], hi = ls[ls.length - 1];
    const pct = (v) => Math.round(v * 100) + '%';

    if (cur.overshootRate >= 0.3) {
      out.push(`At your current setting you <b>overshot ${pct(cur.overshootRate)}</b> of flicks, a sign the sensitivity is on the fast side.`);
    }
    if (cur.undershootRate >= 0.55) {
      out.push(`At your current setting your first motion <b>fell short ${pct(cur.undershootRate)}</b> of the time, so you needed extra corrections, a sign it is on the slow side.`);
    }
    if (hi.overshootRate - lo.overshootRate > 0.15) {
      out.push(`Overshoot climbed from <b>${pct(lo.overshootRate)}</b> at the slowest round to <b>${pct(hi.overshootRate)}</b> at the fastest, which is what we expect, and helps pin the peak.`);
    }
    if (Math.abs(cur.trackLead) > 0.4) {
      out.push(cur.trackLead > 0
        ? `While tracking you tended to <b>run ahead</b> of the target by ${cur.trackLead.toFixed(1)}°, typical of a sensitivity that is a bit high.`
        : `While tracking you tended to <b>trail behind</b> the target by ${Math.abs(cur.trackLead).toFixed(1)}°, typical of a sensitivity that is a bit low.`);
    }
    const bestT = ls.reduce((p, q) => (q.onTarget > p.onTarget ? q : p));
    const bestF = ls.reduce((p, q) => (q.flickScore > p.flickScore ? q : p));
    if (bestT !== bestF) {
      out.push(bestT.m > bestF.m
        ? 'You tracked best at a <b>faster</b> setting than you flicked best at. The recommendation balances both; lean slower if you play tactical shooters, faster for tracking-heavy games.'
        : 'You flicked best at a <b>faster</b> setting than you tracked best at. The recommendation balances both; lean faster for tactical shooters, slower for tracking-heavy games.');
    }
    if (!out.length) out.push('Your movement looked balanced: no strong overshoot, undershoot or tracking lag at your current setting.');
    return out;
  }

  const api = { fittsID, resample, analyzeFlick, analyzeTracking, trackChunks, summarizeLevel, summarizeStats, bootstrap, verdict, rng, fitQuadratic, recommend, insights, median, mean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DPIA = api;
})(this);
