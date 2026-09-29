// Demo (coach) run of a short song for each exercise: every muscle automatic, reps on the beat grid.
//   node scripts/simtest.ts [exercise] [-v] [-w=kg] [-bpm=84] [-reps=2]
import { LiftSession } from '../src/game/session.ts';
import { EXERCISES, type ExerciseId } from '../src/game/exercises.ts';
import { JOINTS } from '../src/sim/body.ts';
import { MUSCLES } from '../src/sim/muscles.ts';

const deg = (r: number) => ((r * 180) / Math.PI).toFixed(0);
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('-')) as ExerciseId | undefined;
const verbose = args.includes('-v');
const num = (k: string, d: number) => Number(args.find((a) => a.startsWith(`-${k}=`))?.split('=')[1] ?? d);
const bpm = num('bpm', 84);
const reps = num('reps', 2);

for (const ex of EXERCISES) {
  if (only && ex.id !== only) continue;
  const s = new LiftSession(ex.id);
  const weight = num('w', ex.weight.def);
  s.configure(ex.id, weight, bpm);
  s.setLanes([]);
  const events: string[] = [];
  s.onEvent = (t, d) => {
    if (t === 'impact') return;
    events.push(`${t}@${s.time.toFixed(2)}${typeof d === 'string' ? ':' + d : ''}`);
  };
  const countIn = 4 * s.spb;
  s.startSong(countIn, reps);
  const end = countIn + reps * s.repDur + 0.2;
  const t0 = performance.now();
  let lastLog = -1;
  for (let t = 0; t < end; t += 1 / 60) {
    s.advanceTo(t);
    const w = s.world;
    if (verbose && s.time - lastLog >= 0.05 && s.time > countIn) {
      lastLog = s.time;
      const [bx, by] = w.barPos();
      const a = w.muscles.a;
      const top = MUSCLES.map((m, i) => [m.id, a[i]] as const)
        .filter((x) => x[1] > 0.15)
        .map((x) => `${x[0]}:${x[1].toFixed(2)}`)
        .join(' ');
      const ang = ['hip', 'knee', 'ankle', 'lumbar', 'shoulder', 'elbow'].map((n) => `${n[0]}${n[1]}=${deg(w.anat[JOINTS.indexOf(n as never)])}`).join(' ');
      console.log(
        `t=${s.time.toFixed(2)} s=${s.s.toFixed(2)} ${s.state.padEnd(7)} ${s.cleanStage.padEnd(6)} ${s.phase?.id?.padEnd(8)} bar=(${bx.toFixed(3)},${by.toFixed(3)}) ${w.barMode} cop=${w.copX.toFixed(3)} ft=${deg(w.mb.th[3])} | ${ang} | ${top}`,
      );
    }
  }
  const ms = performance.now() - t0;
  const res = s.results.map((r) => (r.ok ? `OK(${r.form})` : `FAIL(${r.reason})`)).join(' ');
  console.log(`${ex.id.padEnd(10)} ${weight}kg ${bpm}BPM repBeats=${s.plan.repBeats} -> ${res}  events=${events.join(',')} (${ms.toFixed(0)}ms)`);
}
