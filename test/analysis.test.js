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
