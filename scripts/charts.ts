// Print the generated chart of one rep for each exercise / difficulty (16th-note rows, one column per lane).
//   node scripts/charts.ts [exercise] [-bpm=84]
import { LiftSession } from '../src/game/session.ts';
import { EXERCISES, type Difficulty } from '../src/game/exercises.ts';
import { buildSong } from '../src/game/song.ts';
import { MUSCLES, MI } from '../src/sim/muscles.ts';

const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('-'));
const bpm = Number(args.find((a) => a.startsWith('-bpm='))?.slice(5) ?? 84);
const diffs: Difficulty[] = ['easy', 'normal', 'expert'];

for (const ex of EXERCISES) {
  if (only && ex.id !== only) continue;
  const s = new LiftSession(ex.id);
  for (const diff of diffs) {
    const t0 = performance.now();
    const song = buildSong({ ex: ex.id, weight: ex.weight.def, bpm, diff, reps: 1 }, s);
    const ms = performance.now() - t0;
    const { chart, recording } = song;
    const q = chart.spb / 4;
    const cells = Math.round(chart.repDur / q);
    const grid = Array.from({ length: cells }, () => new Array(chart.lanes.length).fill(' '));
    for (const n of chart.notes) {
      const c = Math.round((n.t - chart.countIn) / q);
      const ce = Math.round((n.end - chart.countIn) / q);
      if (n.hold) for (let k = c + 1; k <= Math.min(cells - 1, ce); k++) grid[k][n.lane] = '|';
      grid[c][n.lane] = n.hold ? 'H' : n.strength > 0.55 ? 'O' : n.strength > 0.3 ? 'o' : '.';
    }
    const phaseAt = new Map<number, string>();
    for (const p of chart.phases) phaseAt.set(Math.round((p.t - chart.countIn) / q), p.label);
    console.log(`\n== ${ex.cn} ${diff} ${bpm}BPM  notes=${chart.notes.length} (${(chart.notes.length / chart.repDur).toFixed(1)}/s)  coach ${recording.ok ? 'OK' : 'FAIL'}  build ${ms.toFixed(0)}ms`);
    console.log('      ' + chart.lanes.map((id) => MUSCLES[MI[id]].id.slice(0, 5).padEnd(6)).join(''));
    for (let c = 0; c < cells; c++) {
      const beat = c % 4 === 0 ? `${String(c / 4).padStart(3)} |` : '    |';
      const row = grid[c].map((x) => `  ${x}   `).join('');
      const mark = phaseAt.has(c) ? `  ← ${phaseAt.get(c)}` : '';
      if (grid[c].some((x) => x !== ' ') || c % 4 === 0 || mark) console.log(`${beat}${row}${mark}`);
    }
  }
}
