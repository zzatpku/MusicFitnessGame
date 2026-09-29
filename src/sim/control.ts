import { Multibody } from '../physics/multibody.ts';
import { cholesky, cholSolve } from '../physics/linalg.ts';
import { B, C, GEO, JI, JOINT_INFO, NJ, ctrlSpecs } from './body.ts';
import { NM, type MuscleSet } from './muscles.ts';
import type { LifterWorld } from './world.ts';

/** Inverse dynamics with the foot treated as fixed to the floor (valid while it is flat). */
export class InverseDynamics {
  readonly mb = new Multibody(ctrlSpecs());
  private readonly qc = new Float64Array(8);
  private readonly qdc = new Float64Array(8);
  private readonly qddc = new Float64Array(8);
  readonly tau = new Float64Array(NJ);
  private readonly barPM = { body: C.forearm as number, lx: 0, ly: -GEO.grip, mass: 0 };

  constructor() {
    this.mb.extra = [this.barPM];
  }

  compute(world: LifterWorld, qddAnat: Float64Array, barLoad: number, gravityOnly = false): Float64Array {
    const mb = this.mb;
    const wm = world.mb;
    mb.rootPose[0] = wm.ox[B.foot];
    mb.rootPose[1] = wm.oy[B.foot];
    mb.rootPose[2] = wm.th[B.foot];
    for (const info of JOINT_INFO) {
      const j = JI[info.name];
      this.qc[info.ctrlDof] = info.ctrlSign * world.anat[j];
      this.qdc[info.ctrlDof] = gravityOnly ? 0 : info.ctrlSign * world.anatVel[j];
      this.qddc[info.ctrlDof] = info.ctrlSign * qddAnat[j];
    }
    const pm = this.barPM;
    pm.mass = 0;
    if (world.barMode === 'hands') {
      pm.body = C.forearm;
      pm.lx = 0;
      pm.ly = -GEO.grip;
      pm.mass = world.barMass * barLoad;
    } else if (world.barMode === 'back' || world.barMode === 'front') {
      const r = world.barMode === 'back' ? GEO.rackBack : GEO.rackFront;
      pm.body = C.thorax;
      pm.lx = r[0];
      pm.ly = r[1];
      pm.mass = world.barMass * barLoad;
    }
    mb.setState(this.qc, this.qdc);
    mb.dynamics();
    const n = mb.n;
    for (const info of JOINT_INFO) {
      const i = info.ctrlDof;
      let s = mb.h[i];
      for (let k = 0; k < n; k++) s += mb.M[i * n + k] * this.qddc[k];
      this.tau[JI[info.name]] = info.ctrlSign * s;
    }
    return this.tau;
  }
}

/** Joint-torque weights for the optimiser (1/Nm² scaled; shrug in N). */
const TAU_SCALE = [25, 25, 25, 25, 3000, 120, 12, 10];

/**
 * Static optimisation: minimise Σ wⱼ (Σᵢ Gⱼᵢ aᵢ + τpⱼ − τⱼ)² + Σ cᵢ aᵢ² over 0 ≤ a ≤ 1.
 * Box-constrained QP solved by projected Newton with an active set (warm-started, exact in a few
 * iterations, so antagonists do not linger in co-contraction the way coordinate descent lets them).
 */
export class StaticOptimizer {
  readonly a = new Float64Array(NM);
  readonly resid = new Float64Array(NJ);
  readonly w = new Float64Array(NJ);
  readonly cost = new Float64Array(NM).fill(1);
  readonly aMin = new Float64Array(NM);
  readonly aMax = new Float64Array(NM).fill(1);
  private readonly H = new Float64Array(NM * NM);
  private readonly f = new Float64Array(NM);
  private readonly c = new Float64Array(NJ);
  private readonly g = new Float64Array(NM);
  private readonly idx = new Int32Array(NM);
  private readonly Hf = new Float64Array(NM * NM);
  private readonly Lf = new Float64Array(NM * NM);
  private readonly rhs = new Float64Array(NM);
  private readonly d = new Float64Array(NM);
  private readonly trial = new Float64Array(NM);

  private objective(a: Float64Array, free: Uint8Array): number {
    let s = 0;
    const { H, f } = this;
    for (let i = 0; i < NM; i++) {
      if (!free[i]) continue;
      let hi = 0;
      for (let k = 0; k < NM; k++) if (free[k]) hi += H[i * NM + k] * a[k];
      s += a[i] * (0.5 * hi + f[i]);
    }
    return s;
  }

  solve(ms: MuscleSet, tauActiveReq: Float64Array, free: Uint8Array, fixedA: Float64Array, jointMask: Uint8Array, iters = 10): Float64Array {
    const { a, resid, w, cost, aMin, aMax, H, f, c, g, idx, Hf, Lf, rhs, d, trial } = this;
    const G = ms.gain;
    for (let j = 0; j < NJ; j++) w[j] = jointMask[j] ? 800 / (TAU_SCALE[j] * TAU_SCALE[j]) : 0;
    for (let i = 0; i < NM; i++) {
      if (!free[i]) a[i] = fixedA[i];
      else a[i] = a[i] < aMin[i] ? aMin[i] : a[i] > aMax[i] ? aMax[i] : a[i];
    }
    for (let j = 0; j < NJ; j++) {
      let s = ms.passiveTorque[j] - tauActiveReq[j];
      for (let i = 0; i < NM; i++) if (!free[i]) s += G[j * NM + i] * a[i];
      c[j] = s;
    }
    for (let i = 0; i < NM; i++) {
      let fi = 0;
      for (let j = 0; j < NJ; j++) fi += w[j] * G[j * NM + i] * c[j];
      f[i] = fi;
      for (let k = i; k < NM; k++) {
        let h = 0;
        for (let j = 0; j < NJ; j++) h += w[j] * G[j * NM + i] * G[j * NM + k];
        if (k === i) h += cost[i];
        H[i * NM + k] = h;
        H[k * NM + i] = h;
      }
    }
    let obj = this.objective(a, free);
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < NM; i++) {
        let s = f[i];
        for (let k = 0; k < NM; k++) if (free[k]) s += H[i * NM + k] * a[k];
        g[i] = s;
      }
      let n = 0;
      for (let i = 0; i < NM; i++) {
        if (!free[i]) continue;
        const atLo = a[i] <= aMin[i] + 1e-9 && g[i] > 0;
        const atHi = a[i] >= aMax[i] - 1e-9 && g[i] < 0;
        if (!atLo && !atHi) idx[n++] = i;
      }
      if (n === 0) break;
      for (let p = 0; p < n; p++) {
        rhs[p] = -g[idx[p]];
        for (let q = 0; q < n; q++) Hf[p * n + q] = H[idx[p] * NM + idx[q]];
      }
      cholesky(Hf, Lf, n);
      cholSolve(Lf, n, rhs, d);
      let step = 1,
        accepted = false,
        maxDa = 0;
      for (let ls = 0; ls < 12; ls++) {
        trial.set(a);
        for (let p = 0; p < n; p++) {
          const i = idx[p];
          const v = a[i] + step * d[p];
          trial[i] = v < aMin[i] ? aMin[i] : v > aMax[i] ? aMax[i] : v;
        }
        const o = this.objective(trial, free);
        if (o <= obj + 1e-12) {
          maxDa = 0;
          for (let i = 0; i < NM; i++) maxDa = Math.max(maxDa, Math.abs(trial[i] - a[i]));
          a.set(trial);
          obj = o;
          accepted = true;
          break;
        }
        step *= 0.5;
      }
      if (!accepted || maxDa < 1e-6) break;
    }
    for (let j = 0; j < NJ; j++) {
      let s = c[j];
      for (let i = 0; i < NM; i++) if (free[i]) s += G[j * NM + i] * a[i];
      resid[j] = s;
    }
    return a;
  }
}

export interface RefSample {
  q: Float64Array;
  qd: Float64Array;
  qdd: Float64Array;
  load: number;
}

export function makeRefSample(): RefSample {
  return { q: new Float64Array(NJ), qd: new Float64Array(NJ), qdd: new Float64Array(NJ), load: 1 };
}

/**
 * Joint-space feedback in torque units (Nm/rad, shrug N/m) and damping (Nm·s/rad, shrug N·s/m).
 * Hip and lumbar carry the whole upper body plus the bar (~12–20 kg·m²), so they need heavy damping
 * to settle after a disturbance (a catch, a missed contraction) without overshooting.
 */
const KT = [1200, 1200, 900, 1400, 150, 12000, 250, 120];
const DT = [180, 120, 60, 180, 20, 500, 20, 10];

/**
 * Reference-tracking controller: inverse-dynamics feedforward along the reference (gravity, load,
 * planned accelerations) + joint PD in torque units → muscle activations by static optimisation.
 */
export class Autopilot {
  readonly id = new InverseDynamics();
  readonly opt = new StaticOptimizer();
  readonly qddDes = new Float64Array(NJ);
  readonly tauReq = new Float64Array(NJ);
  readonly tauActive = new Float64Array(NJ);
  readonly kt = Float64Array.from(KT);
  readonly dt = Float64Array.from(DT);
  readonly allFree = new Uint8Array(NM).fill(1);
  readonly allJoints = new Uint8Array(NJ).fill(1);
  readonly zeros = new Float64Array(NM);
  readonly suggested = new Float64Array(NM);
  gainScale = 1;

  setGains(scale: number): void {
    this.gainScale = scale;
    for (let j = 0; j < NJ; j++) {
      this.kt[j] = KT[j] * scale;
      this.dt[j] = DT[j] * Math.sqrt(scale);
    }
  }

  /**
   * Compute the active (muscle) torque needed to follow `ref`. Joints flagged in `external` are
   * driven by someone else (the player): they use the measured acceleration and get no feedback.
   */
  torques(world: LifterWorld, ref: RefSample, external?: Uint8Array, qddMeas?: Float64Array, fbScale = 1): Float64Array {
    const { qddDes, kt, dt } = this;
    for (let j = 0; j < NJ; j++) qddDes[j] = external && external[j] && qddMeas ? qddMeas[j] : ref.qdd[j];
    const tau = this.id.compute(world, qddDes, ref.load, !!external);
    for (let j = 0; j < NJ; j++) {
      if (!(external && external[j])) tau[j] += fbScale * (kt[j] * (ref.q[j] - world.anat[j]) + dt[j] * (ref.qd[j] - world.anatVel[j]));
      this.tauReq[j] = tau[j];
      this.tauActive[j] = tau[j] - world.tauPassive[j] + world.dampJ[j] * world.anatVel[j];
    }
    return this.tauActive;
  }

  /** Full-body muscle solution (all muscles free, all joints). */
  solveAll(world: LifterWorld, ref: RefSample, fbScale = 1): Float64Array {
    this.torques(world, ref, undefined, undefined, fbScale);
    const a = this.opt.solve(world.muscles, this.tauActive, this.allFree, this.zeros, this.allJoints);
    this.suggested.set(a);
    return this.suggested;
  }
}
