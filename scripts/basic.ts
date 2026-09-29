import { LifterWorld } from '../src/sim/world.ts';
import { PoseFK, makePose, GEO, JOINTS, NJ } from '../src/sim/body.ts';
import { Autopilot, makeRefSample } from '../src/sim/control.ts';
import { solvePose } from '../src/sim/reference.ts';

const fk = new PoseFK();
const deg = (r: number) => ((r * 180) / Math.PI).toFixed(1);

function standPose() {
  const base = makePose({ hip: 2, knee: 3, ankle: 2, lumbar: 0, thoracic: 5, shoulder: 0, elbow: 5, shrug: 0.006 });
  return solvePose(fk, base, [2], (f) => [f.com()[0] - GEO.midfoot]);
}

// 1) passive collapse: no muscles, bar free on the floor
{
  const w = new LifterWorld(60);
  const pose = standPose();
  fk.set(pose);
  const q = fk.toSimQ([0.6, GEO.plateR]);
  w.reset(q, 'free');
  let maxV = 0;
  for (let i = 0; i < 3000; i++) {
    w.step();
    for (let k = 0; k < w.n; k++) maxV = Math.max(maxV, Math.abs(w.qd[k]));
    if (i % 500 === 0) {
      const c = w.com(false);
      console.log(`passive t=${w.time.toFixed(2)} com=(${c[0].toFixed(3)},${c[1].toFixed(3)}) pelvisY=${w.q[1].toFixed(3)} heel=${w.heelF.toFixed(0)} toe=${w.toeF.toFixed(0)} body=${w.bodyFloorF.toFixed(0)}`);
    }
  }
  console.log('passive max |qd| =', maxV.toFixed(2), 'finite:', w.q.every(Number.isFinite));
}

// 2) autopilot holding standing pose
{
  const w = new LifterWorld(60);
  const pose = standPose();
  fk.set(pose);
  const q = fk.toSimQ([0.6, GEO.plateR]);
  w.reset(q, 'free');
  const ap = new Autopilot();
  const ref = makeRefSample();
  ref.q.set(pose);
  ref.load = 0;
  const t0 = performance.now();
  for (let i = 0; i < 4000; i++) {
    const a = ap.solveAll(w, ref);
    w.muscles.u.set(a);
    if (i === 0) w.muscles.a.set(a);
    w.step();
    if (i % 800 === 0) {
      const c = w.com(false);
      const ang = JOINTS.map((n, j) => `${n}=${deg(w.anat[j])}`).join(' ');
      console.log(`hold t=${w.time.toFixed(2)} com=(${c[0].toFixed(3)},${c[1].toFixed(3)}) cop=${w.copX.toFixed(3)} grf=${w.grfY.toFixed(0)} | ${ang}`);
    }
  }
  const ms = (performance.now() - t0) / 4000;
  console.log(`step+control cost: ${(ms * 1000).toFixed(1)} us`);
  const a = w.muscles.a;
  console.log('activations:', w.muscles.specs.map((m, i) => `${m.id}=${a[i].toFixed(2)}`).join(' '));
  let err = 0;
  for (let j = 0; j < NJ; j++) err = Math.max(err, Math.abs(w.anat[j] - pose[j]));
  console.log('max tracking error (deg):', deg(err));
}
