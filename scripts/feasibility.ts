// Inverse dynamics along each reference trajectory: implied centre of pressure and required joint torques.
import { EXERCISES } from '../src/game/exercises.ts';
import { C, GEO, JI, JOINT_INFO, JOINTS, NJ, PoseFK, ctrlSpecs } from '../src/sim/body.ts';
import { Multibody } from '../src/physics/multibody.ts';
import { makeRefSample } from '../src/sim/control.ts';

const only = process.argv[2];
const D = 180 / Math.PI;
for (const ex of EXERCISES) {
  if (only && ex.id !== only) continue;
  const plan = ex.build(ex.weight.def, 60 / 84);
  const mb = new Multibody(ctrlSpecs());
  const pm = { body: C.forearm as number, lx: 0, ly: -GEO.grip, mass: 0 };
  mb.extra = [pm];
  mb.rootPose[0] = 0; mb.rootPose[1] = GEO.ankleH; mb.rootPose[2] = 0;
  const ref = makeRefSample();
  const q = new Float64Array(8), qd = new Float64Array(8), qdd = new Float64Array(8);
  const fk = new PoseFK();
  console.log(`== ${ex.id}`);
  for (let t = 0; t <= plan.timeline.duration; t += 0.02) {
    plan.timeline.sample(t, ref);
    for (const info of JOINT_INFO) {
      const j = JI[info.name];
      q[info.ctrlDof] = info.ctrlSign * ref.q[j];
      qd[info.ctrlDof] = info.ctrlSign * ref.qd[j];
      qdd[info.ctrlDof] = info.ctrlSign * ref.qdd[j];
    }
    const mode = plan.barMode;
    const racked = ex.id === 'clean' && plan.catchFrom !== undefined && t > plan.catchFrom + 0.1;
    if (mode === 'hands' && !racked) { pm.body = C.forearm; pm.lx = 0; pm.ly = -GEO.grip; }
    else { const r = mode === 'back' ? GEO.rackBack : GEO.rackFront; pm.body = C.thorax; pm.lx = r[0]; pm.ly = r[1]; }
    pm.mass = ex.weight.def * ref.load;
    mb.setState(q, qd); mb.dynamics();
    const tau: number[] = [];
    for (const info of JOINT_INFO) {
      let s = mb.h[info.ctrlDof];
      for (let k = 0; k < 8; k++) s += mb.M[info.ctrlDof * 8 + k] * qdd[k];
      tau[JI[info.name]] = info.ctrlSign * s;
    }
    // Ankle torque on the shank = moment about the ankle of the ground reaction; COP ≈ ankle.x − τ_ankle/Fz (plus foot weight).
    fk.set(ref.q);
    const mTot = 80 + pm.mass;
    // vertical GRF ≈ total weight + Σ m a_y (approximate by static weight)
    const Fz = mTot * 9.81;
    const tauAnkleDorsi = tau[JI.ankle];
    const cop = -tauAnkleDorsi / Fz;
    const flag = cop < GEO.heel[0] || cop > GEO.toe[0] ? ' <-- COP OUT' : '';
    console.log(`t=${t.toFixed(1)} load=${ref.load.toFixed(2)} cop=${cop.toFixed(3)}${flag} | ` + JOINTS.map((n, j) => `${n.slice(0,4)}=${tau[j].toFixed(0)}`).join(' '));
  }
}
