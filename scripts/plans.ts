// Keyframe timing (in beats) of every exercise plan at each tempo, to check the beat alignment.
import { EXERCISES } from '../src/game/exercises.ts';
import { TEMPOS } from '../src/game/song.ts';

for (const ex of EXERCISES) {
  for (const { bpm } of TEMPOS) {
    const spb = 60 / bpm;
    const t0 = performance.now();
    const plan = ex.build(ex.weight.def, spb);
    const ms = performance.now() - t0;
    const keys = plan.timeline.keys.map((k) => (k.t / spb).toFixed(2)).join(' ');
    console.log(`${ex.id.padEnd(10)} ${bpm}  repBeats=${plan.repBeats}  (${ms.toFixed(0)}ms)  keys[b]: ${keys}`);
    console.log(`           phases: ${plan.phases.map((p) => `${p.id}@${(p.t / spb).toFixed(2)}`).join(' ')}`);
  }
}
