// Headless rhythm-mode check: bot players on the generated chart, physics driven by their hits.
//   auto   — autoplay (every note perfect)
//   good   — hits 92 % of notes, timing σ 35 ms
//   sloppy — hits 70 % of notes, timing σ 60 ms, some stray presses
//   none   — presses nothing
//   node scripts/playtest.ts [exercise] [-bpm=84] [-reps=3]
import { LiftSession } from '../src/game/session.ts';
import { EXERCISES, type Difficulty } from '../src/game/exercises.ts';
import { buildSong } from '../src/game/song.ts';
import { RhythmGame } from '../src/game/rhythm.ts';
import { MI } from '../src/sim/muscles.ts';

const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('-'));
const num = (k: string, d: number) => Number(args.find((a) => a.startsWith(`-${k}=`))?.split('=')[1] ?? d);
const bpm = num('bpm', 84);
const reps = num('reps', 3);
const diffs: Difficulty[] = ['easy', 'normal', 'expert'];
const bots = { auto: [1, 0, 0], good: [0.92, 0.035, 0], sloppy: [0.7, 0.06, 0.4] } as Record<string, [number, number, number]>;

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

for (const ex of EXERCISES) {
  if (only && ex.id !== only) continue;
  const s = new LiftSession(ex.id);
  for (const diff of diffs) {
    const song = buildSong({ ex: ex.id, weight: ex.weight.def, bpm, diff, reps }, s);
    const chart = song.chart;
    const out: string[] = [];
    for (const bot of [...Object.keys(bots), 'none']) {
      s.setLanes(song.lanes);
      s.reset();
      const rg = new RhythmGame(chart);
      rg.autoplay = bot === 'auto';
      const [pHit, sigma, strayRate] = bots[bot] ?? [0, 0, 0];
      const events: { t: number; lane: number; down: boolean }[] = [];
      if (bot !== 'auto' && bot !== 'none') {
        for (const n of chart.notes) {
          if (rand() > pHit) continue;
          const t = n.t + gauss() * sigma;
          events.push({ t, lane: n.lane, down: true }, { t: (n.hold ? n.end : t + 0.08) + (n.hold && bot === 'sloppy' && rand() < 0.3 ? -0.4 : 0), lane: n.lane, down: false });
        }
        const strays = Math.round(strayRate * chart.duration);
        for (let k = 0; k < strays; k++) {
          const t = rand() * chart.duration;
          const lane = Math.floor(rand() * chart.lanes.length);
          events.push({ t, lane, down: true }, { t: t + 0.08, lane, down: false });
        }
      }
      events.sort((a, b) => a.t - b.t);
      let ei = 0;
      s.startSong(chart.countIn, chart.reps);
      for (let t = 0; t < chart.duration; t += 1 / 60) {
        while (ei < events.length && events[ei].t <= t) {
          const e = events[ei++];
          if (e.down) {
            if (rg.press(e.lane, e.t) === 'stray') s.pulse(MI[chart.lanes[e.lane]], 0.3);
          } else rg.release(e.lane, e.t);
        }
        rg.update(t);
        chart.lanes.forEach((id, lane) => (s.gate[MI[id]] = rg.gateAt(lane)));
        s.advanceTo(t);
      }
      const ok = s.results.filter((r) => r.ok).length;
      out.push(`${bot}:${ok}/${reps} ${(rg.finalAccuracy * 100).toFixed(0)}%`);
      if (args.includes('-v') && bot === 'good')
        for (const r of s.results) if (!r.ok) console.log(`   ${ex.id} ${diff} good rep${r.rep}: ${r.reason}  (misses per lane: ${chart.lanes.map((id, l) => `${id}:${rg.laneMiss[l]}`).join(' ')})`);
    }
    const nps = chart.notes.length / (chart.reps * chart.repDur);
    console.log(`${ex.id.padEnd(10)} ${diff.padEnd(6)} ${chart.lanes.length}K ${nps.toFixed(1)}n/s  ${out.join('  ')}`);
  }
}
