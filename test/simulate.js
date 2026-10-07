// Monte Carlo check of run-to-run stability: node test/simulate.js [opt] [flicks] [trackSec] [runs]
// A synthetic player whose true best multiplier is `opt` plays the test many times.
const A = require('../js/analysis.js');
const curv = +(process.argv[6] || 1);
const opt = +(process.argv[2] || 1), flicks = +(process.argv[3] || 12), trackSec = +(process.argv[4] || 8), runs = +(process.argv[5] || 300);
const LEVELS = [0.6, 0.78, 1, 1.28, 1.65];
const r = A.rng(42);
const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

function play() {
  return LEVELS.map((m) => {
    const d2 = curv * Math.log(m / opt) ** 2;
    const fs = [];
    for (let i = 0; i < flicks; i++) {
      const D = 10 + r() * 40, rad = i % 2 ? 2.2 : 1.4, id = A.fittsID(D, rad);
      const t = (350 + 120 * id) * (1 + 0.6 * d2) * Math.exp(0.25 * gauss());
      const missP = 0.08 + 0.25 * Math.max(0, Math.log(m / opt));
      const miss = r() < missP ? 1 : 0;
      fs.push({ hit: true, timeMs: t, id, missClicks: miss, overshoot: false, undershoot: false, corrections: 0 });
    }
    const ts = [];
    for (let i = 0; i < trackSec; i++) {
      const on = Math.min(1, Math.max(0, 0.55 - 0.25 * d2 + 0.12 * gauss()));
      ts.push({ onTarget: on, meanErr: 1, lead: 0, seconds: 1 });
    }
    return A.summarizeStats(m, fs, ts);
  });
}

const oldM = [], newM = [], keeps = [], cover = [];
for (let i = 0; i < runs; i++) {
  const ls = play();
  oldM.push(A.recommend(ls.map((l) => ({ ...l }))).multiplier);
  const v = A.verdict(ls);
  newM.push(v.multiplier); keeps.push(v.keep); cover.push(v.band.lo <= opt && opt <= v.band.hi);
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const fmt = (a) => `10%=${q(a, .1).toFixed(2)} median=${q(a, .5).toFixed(2)} 90%=${q(a, .9).toFixed(2)}`;
console.log(`true optimum ${opt}x, curvature ${curv}, ${flicks} flicks + ${trackSec}s tracking per round, ${runs} runs`);
console.log('old single-number result :', fmt(oldM));
console.log('new result               :', fmt(newM));
console.log('said "keep current"      :', Math.round(100 * keeps.filter(Boolean).length / runs) + '%');
console.log('range contained the truth:', Math.round(100 * cover.filter(Boolean).length / runs) + '%');
