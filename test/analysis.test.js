// Run with: node test/analysis.test.js
const assert = require('assert');
const A = require('../js/analysis.js');

// Synthetic flick: ballistic move that ends at `firstEnd` x D, then corrects onto target.
function flick(D, firstEnd, overshoot) {
  const samples = [];
  let t = 0;
  const peak = firstEnd * (1 + overshoot);
  for (let i = 1; i <= 50; i++) { t = i * 4; const k = 0.5 - 0.5 * Math.cos(Math.PI * i / 50); samples.push({ t, x: peak * D * k, y: 0 }); }
  for (let i = 1; i <= 40; i++) { t = 200 + i * 4; const k = 0.5 - 0.5 * Math.cos(Math.PI * i / 40); samples.push({ t, x: (peak + (1 - peak) * k) * D, y: 0 }); }
  return { tx: D, ty: 0, radius: 1.5, samples, startT: 0, hitT: t + 20, missClicks: 0 };
}

const f1 = A.analyzeFlick(flick(30, 1.2, 0));
assert(f1.overshoot, 'overshoot detected');
assert(!f1.undershoot);
const f2 = A.analyzeFlick(flick(30, 0.7, 0));
assert(f2.undershoot && !f2.overshoot, 'undershoot detected');
assert(f2.corrections >= 1, 'correction counted');

// Recommendation should peak near the synthetic optimum.
const opt = 0.85;
const levels = [0.6, 0.78, 1, 1.28, 1.65].map((m) => {
  const q = Math.exp(-((Math.log(m / opt)) ** 2) / 0.3);
  return { m, throughput: 4 * q, accuracy: 0.9, onTarget: 0.5 * q + 0.1 };
});
const rec = A.recommend(levels);
console.log('multiplier', rec.multiplier.toFixed(3), rec.confidence, rec.method);
assert(Math.abs(rec.multiplier - opt) < 0.05, 'peak found');
assert.strictEqual(rec.confidence, 'high');

// Edge case: monotonic -> edge, low confidence.
const edge = A.recommend([0.6, 0.78, 1, 1.28, 1.65].map((m) => ({ m, throughput: m, accuracy: 1, onTarget: m / 2 })));
assert(edge.atEdge && edge.confidence === 'low');

const tr = A.analyzeTracking([{ dt: 10, err: 1, on: true, lead: 0.5 }, { dt: 10, err: 3, on: false, lead: -0.5 }]);
assert.strictEqual(tr.onTarget, 0.5);
console.log('all analysis tests passed');

// Verdict: a player whose true best is their current setting should be told to keep it,
// and one whose best is clearly slower should be told to change.
function player(opt, seed) {
  const r = A.rng(seed);
  const g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  return [0.6, 0.78, 1, 1.28, 1.65].map((m) => {
    const d2 = Math.log(m / opt) ** 2;
    const fs = Array.from({ length: 12 }, (_, i) => {
      const id = A.fittsID(10 + r() * 40, i % 2 ? 2.2 : 1.4);
      return { hit: true, timeMs: (350 + 120 * id) * (1 + 0.6 * d2) * Math.exp(0.25 * g()), id, missClicks: 0 };
    });
    const ts = Array.from({ length: 8 }, () => ({ onTarget: 0.55 - 0.25 * d2 + 0.12 * g(), meanErr: 1, lead: 0, seconds: 1 }));
    return A.summarizeStats(m, fs, ts);
  });
}
let keepCount = 0;
for (let s = 1; s <= 20; s++) if (A.verdict(player(1, s)).keep) keepCount++;
console.log('keep verdicts for an already-optimal player:', keepCount, '/ 20');
assert(keepCount >= 14, 'mostly keeps an optimal setting');
let changeCount = 0;
for (let s = 1; s <= 20; s++) { const v = A.verdict(player(0.65, s)); if (!v.keep && v.multiplier < 1) changeCount++; }
console.log('slower verdicts for a player whose best is 0.65x:', changeCount, '/ 20');
assert(changeCount >= 16, 'mostly recommends slower when clearly too fast');
console.log('verdict tests passed');
