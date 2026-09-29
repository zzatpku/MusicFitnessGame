// Headless rhythm-mode check: bot players on the generated chart, physics driven by their presses.
//   auto    — autoplay (every note perfect)
//   good    — hits 92 % of notes, timing σ 35 ms
//   sloppy  — hits 70 % of notes, timing σ 60 ms, some stray presses
//   none    — presses nothing
//   holdAll — holds every key down for the whole song
//   mash    — hammers every key 10 times a second
//   node scripts/playtest.ts [exercise] [-bpm=84] [-reps=3] [-v]
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
const diffs: Difficulty[] = ['easy', 'normal', 'hard', 'expert'];
const bots = ['auto', 'good', 'sloppy', 'none', 'holdAll', 'mash'] as const;
const accuracy: Record<string, [number, number, number]> = { good: [0.92, 0.035, 0], sloppy: [0.7, 0.06, 0.4] };

let seed = 12345;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

for (const ex of EXERCISES) {
  if (only && ex.id !== only) continue;
  const s = new LiftSession(ex.id);
  for (const diff of diffs) {
    const song = buildSong({ ex: ex.id, weight: ex.weight.def, bpm, diff, reps }, s);
    const chart = song.chart;
    const out: string[] = [];
    for (const bot of bots) {
      s.setLanes(song.lanes);
      s.reset();
      const rg = new RhythmGame(chart);
      rg.autoplay = bot === 'auto';
      const events: { t: number; lane: number; down: boolean }[] = [];
      if (bot === 'good' || bot === 'sloppy') {
        const [pHit, sigma, strayRate] = accuracy[bot];
        for (const n of chart.notes) {
          if (rand() > pHit) continue;
          const t = n.t + gauss() * sigma;
          events.push({ t, lane: n.lane, down: true }, { t: (n.hold ? n.end : t + 0.08) + (n.hold && bot === 'sloppy' && rand() < 0.3 ? -0.4 : 0), lane: n.lane, down: false });
        }
        for (let k = 0; k < Math.round(strayRate * chart.duration); k++) {
          const t = rand() * chart.duration;
          const lane = Math.floor(rand() * chart.lanes.length);
          events.push({ t, lane, down: true }, { t: t + 0.08, lane, down: false });
        }
      } else if (bot === 'holdAll') {
        chart.lanes.forEach((_, lane) => events.push({ t: 0.01, lane, down: true }));
      } else if (bot === 'mash') {
        chart.lanes.forEach((_, lane) => {
          for (let t = 0.02 + lane * 0.011; t < chart.duration; t += 0.1) events.push({ t, lane, down: true }, { t: t + 0.04, lane, down: false });
        });
      }
      events.sort((a, b) => a.t - b.t);
      let ei = 0;
      s.startSong(chart.countIn, chart.reps);
      for (let t = 0; t < chart.duration; t += 1 / 60) {
        while (ei < events.length && events[ei].t <= t) {
          const e = events[ei++];
          if (e.down) rg.press(e.lane, e.t);
          else rg.release(e.lane, e.t);
        }
        rg.update(t);
        chart.lanes.forEach((id, lane) => {
          const d = rg.driveAt(lane, t);
          s.drive[MI[id]] = d.ratio;
          s.excess[MI[id]] = d.excess;
        });
        s.advanceTo(t);
      }
      const ok = s.results.filter((r) => r.ok);
      const dev = s.results.length ? s.results.reduce((a, r) => a + r.deviation, 0) / s.results.length : 0;
      out.push(`${bot}:${ok.length}/${reps} ${(rg.finalAccuracy * 100).toFixed(0)}% ${dev.toFixed(0)}°`);
      if (args.includes('-v')) for (const r of s.results) console.log(`   ${ex.id} ${diff} ${bot} rep${r.rep}: ${r.ok ? `OK form ${r.form} (${r.details.join('; ')})` : r.reason} dev ${r.deviation.toFixed(1)}°`);
    }
    console.log(`${ex.id.padEnd(10)} ${diff.padEnd(6)} ${chart.lanes.length}K  ${out.join('  ')}`);
  }
}
