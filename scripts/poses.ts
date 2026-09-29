import { EXERCISES } from '../src/game/exercises.ts';
import { C, GEO, JOINTS, PoseFK } from '../src/sim/body.ts';

const fk = new PoseFK();
const d = (r: number) => ((r * 180) / Math.PI).toFixed(0).padStart(4);
for (const ex of EXERCISES) {
  const plan = ex.build(ex.weight.def, 60 / 84);
  console.log(`== ${ex.id} (${ex.weight.def}kg)`);
  for (const k of plan.timeline.keys) {
    fk.set(k.pose);
    const g = fk.grip();
    const hip = fk.point(C.pelvis, 0, 0);
    const sh = fk.point(C.girdle, 0, 0);
    const com = fk.com();
    const lean = (-fk.angle(C.thorax) * 180) / Math.PI;
    const ang = JOINTS.map((n, j) => `${n.slice(0, 3)}=${n === 'shrug' ? (k.pose[j] * 100).toFixed(1).padStart(4) : d(k.pose[j])}`).join(' ');
    console.log(
      `t=${k.t.toFixed(2)} L=${k.load.toFixed(1)} ${ang} | grip=(${g[0].toFixed(3)},${g[1].toFixed(3)}) hip=(${hip[0].toFixed(2)},${hip[1].toFixed(2)}) sh=(${sh[0].toFixed(2)},${sh[1].toFixed(2)}) com=${com[0].toFixed(3)} lean=${lean.toFixed(0)}`,
    );
  }
}
console.log('midfoot', GEO.midfoot);
