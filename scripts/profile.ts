// Coach activation per muscle over one rep (mean per 8th note), to see what the chart is built from.
//   node scripts/profile.ts [exercise] [-bpm=84] [-w=kg]
import { LiftSession } from '../src/game/session.ts';
import { EXERCISES } from '../src/game/exercises.ts';
import { recordCoach } from '../src/game/song.ts';
import { MUSCLES } from '../src/sim/muscles.ts';

const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('-'));
const bpm = Number(args.find((a) => a.startsWith('-bpm='))?.slice(5) ?? 84);
const wArg = args.find((a) => a.startsWith('-w='));

for (const ex of EXERCISES) {
  if (only && ex.id !== only) continue;
  const s = new LiftSession(ex.id);
  s.configure(ex.id, wArg ? Number(wArg.slice(3)) : ex.weight.def, bpm);
  const rec = recordCoach(s);
  const step = s.spb / 2;
  const n = Math.round(rec.duration / step);
  console.log(`\n== ${ex.cn} ${bpm}BPM repBeats=${s.plan.repBeats} coach ${rec.ok ? 'OK' : 'FAIL'}  phases: ${s.plan.phases.map((p) => `${p.cn}@${(p.t / s.spb).toFixed(2)}b`).join(' ')}`);
  console.log('beat   ' + MUSCLES.map((m) => m.id.slice(0, 5).padEnd(6)).join(''));
  for (let c = 0; c < n; c++) {
    const k0 = Math.floor((c * step) / rec.dt),
      k1 = Math.floor(((c + 1) * step) / rec.dt);
    const row = MUSCLES.map((_, i) => {
      let sum = 0;
      for (let k = k0; k < k1; k++) sum += rec.act[i][k];
      const v = sum / (k1 - k0);
      return (v < 0.05 ? '  .' : v.toFixed(2).slice(1)).padStart(4) + '  ';
    }).join('');
    console.log(`${(c / 2).toFixed(1).padStart(4)}   ${row}`);
  }
}
