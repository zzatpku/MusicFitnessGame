import { Multibody } from '../physics/multibody.ts';
import { RowPool, solvePGS } from '../physics/solver.ts';
import { cholesky, cholSolve, DEG } from '../physics/linalg.ts';
import { B, BAR_DOF, GEO, JI, JOINT_INFO, NJ, SIM_N, simSpecs } from './body.ts';
import { MI, MuscleSet } from './muscles.ts';

export type BarMode = 'hands' | 'back' | 'front' | 'free';

interface PassiveSpec {
  k: number;
  s: number;
  d: number;
  lin: number;
  rest: number;
}

/** Non-muscular joint tissue: exponential end-range stiffness, linear stiffness about a rest value, damping. */
const PASSIVE: PassiveSpec[] = [
  { k: 8, s: 0.1, d: 2.0, lin: 0, rest: 0 },
  { k: 4, s: 0.1, d: 2.0, lin: 0, rest: 0 },
  { k: 4, s: 0.1, d: 1.5, lin: 0, rest: 0 },
  { k: 8, s: 0.12, d: 5.0, lin: 60, rest: 0 },
  { k: 10, s: 0.1, d: 30.0, lin: 5000, rest: 5 * DEG },
  { k: 0, s: 1, d: 120, lin: 5000, rest: 0.006 },
  { k: 2, s: 0.15, d: 0.8, lin: 0, rest: 0 },
  { k: 2, s: 0.1, d: 0.6, lin: 0, rest: 0 },
];

/**
 * Passive joint torque (anatomical sign) and damping coefficient. Core/erector co-contraction
 * ("bracing") stiffens the spine around neutral.
 */
export function passiveJoint(j: number, x: number, act: Float64Array, damp: Float64Array): number {
  const p = PASSIVE[j];
  const info = JOINT_INFO[j];
  let tau = -p.lin * (x - p.rest);
  if (p.k > 0) {
    const e1 = Math.min(6, (info.min + 2 * p.s - x) / p.s);
    const e2 = Math.min(6, (x - info.max + 2 * p.s) / p.s);
    tau += p.k * (Math.exp(e1) - Math.exp(e2));
  }
  let d = p.d;
  if (j === JI.lumbar || j === JI.thoracic) {
    const ac = act[MI.core],
      ae = act[MI.erectors];
    const kb = j === JI.lumbar ? 320 * ac + 120 * ae : 220 * ac + 80 * ae;
    tau -= kb * (x - p.rest);
    d += 12 * ac;
  }
  damp[j] = d;
  return tau;
}

const KEY = {
  heelN: 1,
  heelT: 2,
  toeN: 3,
  toeT: 4,
  barFloorN: 5,
  barFloorT: 6,
  gripX: 7,
  gripY: 8,
  rackX: 9,
  rackY: 10,
  pinN: 11,
  pinT: 12,
  capsule: 20,
  body: 40,
  limit: 80,
};

const BAUM = 0.2;
const SLOP = 0.0005;

/** Capsules (body, local A, local B, radius) the barbell can collide with. */
export const BAR_CAPSULES: [number, number, number, number, number, number][] = [
  [B.shank, -0.01, -0.03, -0.014, -0.36, 0.03],
  [B.thigh, 0.015, -0.06, 0.012, -0.4, 0.068],
  [B.lumbar, 0.055, -0.02, 0.06, 0.19, 0.085],
  [B.thorax, 0.06, 0.0, 0.07, 0.2, 0.09],
];

/** Body points that may touch the floor if the lifter falls. */
const BODY_FLOOR: [number, number, number, number][] = [
  [B.shank, 0, 0, 0.055],
  [B.pelvis, -0.1, -0.03, 0.08],
  [B.thorax, GEO.head[0], GEO.head[1], 0.1],
  [B.thorax, 0.06, 0.24, 0.09],
  [B.upperarm, 0, -GEO.upperArm, 0.04],
  [B.forearm, 0, -GEO.grip, 0.04],
];

export interface StepEvents {
  gripFail?: boolean;
  barImpact?: number;
}

export class LifterWorld {
  readonly n = SIM_N;
  readonly mb: Multibody;
  readonly q = new Float64Array(SIM_N);
  readonly qd = new Float64Array(SIM_N);
  readonly muscles = new MuscleSet();
  readonly anat = new Float64Array(NJ);
  readonly anatVel = new Float64Array(NJ);
  /** Non-muscular passive joint torque (anatomical). */
  readonly tauPassive = new Float64Array(NJ);
  readonly dampJ = new Float64Array(NJ);
  /** Net joint torque = muscles + passive tissue (anatomical). */
  readonly tauJoint = new Float64Array(NJ);

  barMass = 60;
  plateR = GEO.plateR;
  barMode: BarMode = 'hands';
  /** With the bar racked, the hands rest on it: shoulder/elbow are passively held near these angles. */
  armHold: { shoulder: number; elbow: number } | null = null;
  pinsY: number | null = null;
  time = 0;
  dt = 1 / 1000;
  iterations = 30;
  gripOverride = -1;

  private captureLocal = [0, 0];
  private captureT0 = 0;
  private captureDur = 0;

  heelF = 0;
  toeF = 0;
  copX = 0;
  grfX = 0;
  grfY = 0;
  gripFx = 0;
  gripFy = 0;
  gripDemand = 0;
  barFloorF = 0;
  pinF = 0;
  capsuleF = 0;
  bodyFloorF = 0;
  gripSlip = 0;
  events: StepEvents = {};

  private readonly pool: RowPool;
  private readonly warm = new Map<number, number>();
  private readonly Meff: Float64Array;
  private readonly L: Float64Array;
  private readonly rhs: Float64Array;
  private readonly acc: Float64Array;
  private readonly vstar: Float64Array;
  private readonly D: Float64Array;
  private readonly Q: Float64Array;
  private readonly Jx: Float64Array;
  private readonly Jy: Float64Array;
  private readonly Jx2: Float64Array;
  private readonly Jy2: Float64Array;
  private readonly p = new Float64Array(2);
  private readonly p2 = new Float64Array(2);
  private idx = { heelN: -1, toeN: -1, heelT: -1, toeT: -1, barN: -1, gripX: -1, gripY: -1, pinN: -1 };
  private capsuleRows: number[] = [];
  private bodyRows: number[] = [];

  constructor(barMass = 60) {
    this.mb = new Multibody(simSpecs(barMass, 0.01));
    const n = SIM_N;
    this.pool = new RowPool(n);
    this.Meff = new Float64Array(n * n);
    this.L = new Float64Array(n * n);
    this.rhs = new Float64Array(n);
    this.acc = new Float64Array(n);
    this.vstar = new Float64Array(n);
    this.D = new Float64Array(n);
    this.Q = new Float64Array(n);
    this.Jx = new Float64Array(n);
    this.Jy = new Float64Array(n);
    this.Jx2 = new Float64Array(n);
    this.Jy2 = new Float64Array(n);
    this.setBarMass(barMass);
  }

  setBarMass(m: number): void {
    this.barMass = m;
    const spec = this.mb.specs[B.bar];
    spec.mass = m;
    const plates = Math.max(0, m - 20);
    spec.inertia = 0.004 + 0.5 * plates * (0.225 * 0.225 + 0.025 * 0.025);
    this.plateR = plates >= 9.9 ? GEO.plateR : 0.2;
  }

  reset(q: Float64Array, mode: BarMode): void {
    this.q.set(q);
    this.qd.fill(0);
    this.barMode = mode;
    this.time = 0;
    this.warm.clear();
    this.muscles.reset();
    this.captureDur = 0;
    this.gripSlip = 0;
    this.events = {};
    this.refreshKinematics();
  }

  /** Update kinematics + anatomical angles without stepping (after reset or external edits). */
  refreshKinematics(): void {
    this.mb.setState(this.q, this.qd);
    for (const info of JOINT_INFO) {
      const j = JI[info.name];
      this.anat[j] = info.simSign * this.q[info.simDof];
      this.anatVel[j] = info.simSign * this.qd[info.simDof];
    }
    this.muscles.compute(this.anat, this.anatVel);
    for (let j = 0; j < NJ; j++) this.tauPassive[j] = passiveJoint(j, this.anat[j], this.muscles.a, this.dampJ);
  }

  /** Move the bar from the hands (or free) onto the back/front rack; `dur` > 0 blends the capture. */
  rack(place: 'back' | 'front', dur = 0): void {
    const mb = this.mb;
    const r = place === 'back' ? GEO.rackBack : GEO.rackFront;
    mb.worldPoint(B.thorax, r[0], r[1], this.p);
    const dx = this.q[BAR_DOF] - this.p[0],
      dy = this.q[BAR_DOF + 1] - this.p[1];
    const th = mb.th[B.thorax];
    const c = Math.cos(th),
      s = Math.sin(th);
    this.captureLocal[0] = c * dx + s * dy;
    this.captureLocal[1] = -s * dx + c * dy;
    this.captureT0 = this.time;
    this.captureDur = dur;
    if (dur <= 0) {
      this.captureLocal[0] = 0;
      this.captureLocal[1] = 0;
    }
    this.barMode = place;
  }

  release(): void {
    this.barMode = 'free';
  }

  grip(): void {
    this.barMode = 'hands';
    this.gripSlip = 0;
  }

  step(): StepEvents {
    const dt = this.dt;
    const n = SIM_N;
    const { mb, q, qd, Meff, L, rhs, acc, vstar, D, Q } = this;
    this.events = {};
    mb.setState(q, qd);
    mb.dynamics();
    for (const info of JOINT_INFO) {
      const j = JI[info.name];
      this.anat[j] = info.simSign * q[info.simDof];
      this.anatVel[j] = info.simSign * qd[info.simDof];
    }
    const ms = this.muscles;
    ms.updateActivation(dt);
    ms.compute(this.anat, this.anatVel);

    Q.fill(0);
    D.fill(0);
    const hold = this.barMode === 'back' || this.barMode === 'front' ? this.armHold : null;
    for (const info of JOINT_INFO) {
      const j = JI[info.name];
      let tp = passiveJoint(j, this.anat[j], ms.a, this.dampJ);
      if (hold && (j === JI.shoulder || j === JI.elbow)) {
        tp -= 220 * (this.anat[j] - (j === JI.shoulder ? hold.shoulder : hold.elbow));
        this.dampJ[j] += 6;
      }
      this.tauPassive[j] = tp;
      const tau = ms.torque[j] + tp;
      this.tauJoint[j] = tau - this.dampJ[j] * this.anatVel[j];
      Q[info.simDof] += info.simSign * tau;
      D[info.simDof] = this.dampJ[j];
    }
    D[BAR_DOF + 2] = this.barMode === 'free' ? 0.05 : 0.5;

    Meff.set(mb.M);
    for (let i = 0; i < n; i++) {
      Meff[i * n + i] += dt * D[i] + 1e-9;
      rhs[i] = Q[i] - mb.h[i] - D[i] * qd[i];
    }
    cholesky(Meff, L, n);
    cholSolve(L, n, rhs, acc);
    for (let i = 0; i < n; i++) vstar[i] = qd[i] + dt * acc[i];

    this.buildRows();
    solvePGS(this.pool, L, n, vstar, this.iterations, this.warm);
    this.readTelemetry();

    for (let i = 0; i < n; i++) {
      qd[i] = vstar[i];
      q[i] += dt * qd[i];
    }
    this.time += dt;
    return this.events;
  }

  // ---------------------------------------------------------------- constraints

  private speculativeBias(gap: number, vn: number, restitution: number): number {
    let bias = gap > 0 ? -gap / this.dt : Math.min(0.6, (BAUM * (-gap - SLOP > 0 ? -gap - SLOP : 0)) / this.dt);
    if (restitution > 0 && vn < -0.9) bias = Math.max(bias, -restitution * vn);
    return bias;
  }

  private addGround(key: number, body: number, lx: number, ly: number, radius: number, mu: number, rest: number): number {
    const { mb, p, Jx, Jy, pool } = this;
    mb.worldPoint(body, lx, ly, p);
    const gap = p[1] - radius;
    if (gap > 0.03) return -1;
    mb.jacobian(body, p[0], p[1] - radius, Jx, Jy);
    let vn = 0;
    for (let i = 0; i < this.n; i++) vn += Jy[i] * this.qd[i];
    const rn = pool.alloc(key);
    rn.J.set(Jy);
    rn.bias = this.speculativeBias(gap, vn, rest);
    const ni = pool.last();
    const rt = pool.alloc(key + 1000);
    rt.J.set(Jx);
    rt.normal = ni;
    rt.mu = mu;
    if (rest > 0 && vn < -0.9 && gap < 0.01) this.events.barImpact = Math.max(this.events.barImpact ?? 0, -vn);
    return ni;
  }

  private addBarCapsule(key: number, body: number, ax: number, ay: number, bx: number, by: number, radius: number): number {
    const { mb, p, p2, Jx, Jy, Jx2, Jy2, pool, q } = this;
    mb.worldPoint(body, ax, ay, p);
    mb.worldPoint(body, bx, by, p2);
    const Px = q[BAR_DOF],
      Py = q[BAR_DOF + 1];
    const ex = p2[0] - p[0],
      ey = p2[1] - p[1];
    let t = ((Px - p[0]) * ex + (Py - p[1]) * ey) / (ex * ex + ey * ey);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const Cx = p[0] + t * ex,
      Cy = p[1] + t * ey;
    const dx = Px - Cx,
      dy = Py - Cy;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return -1;
    const gap = d - radius - GEO.shaftR;
    if (gap > 0.03) return -1;
    const nx = dx / d,
      ny = dy / d;
    mb.jacobian(B.bar, Px - nx * GEO.shaftR, Py - ny * GEO.shaftR, Jx2, Jy2);
    mb.jacobian(body, Cx + nx * radius, Cy + ny * radius, Jx, Jy);
    const rn = pool.alloc(key);
    let vn = 0;
    for (let i = 0; i < this.n; i++) {
      rn.J[i] = nx * (Jx2[i] - Jx[i]) + ny * (Jy2[i] - Jy[i]);
      vn += rn.J[i] * this.qd[i];
    }
    rn.bias = this.speculativeBias(gap, vn, 0);
    const ni = pool.last();
    const rt = pool.alloc(key + 1000);
    for (let i = 0; i < this.n; i++) rt.J[i] = -ny * (Jx2[i] - Jx[i]) + nx * (Jy2[i] - Jy[i]);
    rt.normal = ni;
    rt.mu = 0.25;
    return ni;
  }

  private addPointWeld(keyX: number, body: number, wx: number, wy: number, capacity: number, beta: number): number {
    const { mb, Jx, Jy, Jx2, Jy2, pool, q } = this;
    const bx = q[BAR_DOF],
      by = q[BAR_DOF + 1];
    mb.jacobian(body, wx, wy, Jx, Jy);
    mb.jacobian(B.bar, bx, by, Jx2, Jy2);
    const ex = wx - bx,
      ey = wy - by;
    const rx = pool.alloc(keyX);
    const ix = pool.last();
    const ry = pool.alloc(keyX + 1);
    for (let i = 0; i < this.n; i++) {
      rx.J[i] = Jx[i] - Jx2[i];
      ry.J[i] = Jy[i] - Jy2[i];
    }
    rx.bias = (-beta * ex) / this.dt;
    ry.bias = (-beta * ey) / this.dt;
    const lim = capacity * this.dt;
    rx.lo = -lim;
    rx.hi = lim;
    ry.lo = -lim;
    ry.hi = lim;
    return ix;
  }

  private buildRows(): void {
    const { mb, pool, p, q } = this;
    pool.reset();
    const idx = this.idx;
    idx.heelN = this.addGround(KEY.heelN, B.foot, GEO.heel[0], GEO.heel[1], 0, 1.0, 0);
    idx.heelT = idx.heelN >= 0 ? idx.heelN + 1 : -1;
    idx.toeN = this.addGround(KEY.toeN, B.foot, GEO.toe[0], GEO.toe[1], 0, 1.0, 0);
    idx.toeT = idx.toeN >= 0 ? idx.toeN + 1 : -1;
    idx.barN = this.addGround(KEY.barFloorN, B.bar, 0, 0, this.plateR, 0.5, 0.28);

    idx.gripX = idx.gripY = -1;
    if (this.barMode === 'hands') {
      mb.worldPoint(B.forearm, 0, -GEO.grip, p);
      const gripAct = this.gripOverride >= 0 ? this.gripOverride : this.muscles.a[MI.grip];
      const cap = 150 + this.muscles.specs[MI.grip].fmax * gripAct;
      idx.gripX = this.addPointWeld(KEY.gripX, B.forearm, p[0], p[1], cap, 0.25);
      idx.gripY = idx.gripX + 1;
      const e = Math.hypot(p[0] - q[BAR_DOF], p[1] - q[BAR_DOF + 1]);
      this.gripSlip = e;
      if (e > 0.06) {
        this.barMode = 'free';
        this.events.gripFail = true;
      }
    } else if (this.barMode === 'back' || this.barMode === 'front') {
      const r = this.barMode === 'back' ? GEO.rackBack : GEO.rackFront;
      let s = 0;
      if (this.captureDur > 0) {
        s = 1 - (this.time - this.captureT0) / this.captureDur;
        if (s < 0) s = 0;
        const k = s * s * (3 - 2 * s);
        s = k;
      }
      mb.worldPoint(B.thorax, r[0] + this.captureLocal[0] * s, r[1] + this.captureLocal[1] * s, p);
      this.addPointWeld(KEY.rackX, B.thorax, p[0], p[1], Infinity, 0.25);
    }

    this.capsuleRows.length = 0;
    if (this.barMode === 'hands' || this.barMode === 'free') {
      BAR_CAPSULES.forEach((c, i) => {
        const r = this.addBarCapsule(KEY.capsule + 2 * i, c[0], c[1], c[2], c[3], c[4], c[5]);
        if (r >= 0) this.capsuleRows.push(r);
      });
    }

    idx.pinN = -1;
    if (this.pinsY !== null) {
      const gap = q[BAR_DOF + 1] - GEO.shaftR - this.pinsY;
      if (gap < 0.03) {
        const { Jx, Jy } = this;
        mb.jacobian(B.bar, q[BAR_DOF], q[BAR_DOF + 1] - GEO.shaftR, Jx, Jy);
        let vn = 0;
        for (let i = 0; i < this.n; i++) vn += Jy[i] * this.qd[i];
        const rn = pool.alloc(KEY.pinN);
        rn.J.set(Jy);
        rn.bias = this.speculativeBias(gap, vn, 0.1);
        idx.pinN = pool.last();
        const rt = pool.alloc(KEY.pinT);
        rt.J.set(Jx);
        rt.normal = idx.pinN;
        rt.mu = 0.4;
      }
    }

    this.bodyRows.length = 0;
    BODY_FLOOR.forEach((b, i) => {
      const r = this.addGround(KEY.body + 2 * i, b[0], b[1], b[2], b[3], 0.8, 0);
      if (r >= 0) this.bodyRows.push(r);
    });

    for (const info of JOINT_INFO) {
      const j = JI[info.name];
      const x = this.anat[j];
      const v = this.anatVel[j];
      const margin = info.linear ? 0.004 : 0.03;
      const glo = x - info.min;
      if (glo < margin) {
        const r = pool.alloc(KEY.limit + 2 * j);
        r.J[info.simDof] = info.simSign;
        r.bias = this.speculativeBias(glo, v, 0);
      }
      const ghi = info.max - x;
      if (ghi < margin) {
        const r = pool.alloc(KEY.limit + 2 * j + 1);
        r.J[info.simDof] = -info.simSign;
        r.bias = this.speculativeBias(ghi, -v, 0);
      }
    }
  }

  private readTelemetry(): void {
    const rows = this.pool.rows;
    const idx = this.idx;
    const inv = 1 / this.dt;
    const lam = (i: number) => (i >= 0 ? rows[i].lambda * inv : 0);
    this.heelF = lam(idx.heelN);
    this.toeF = lam(idx.toeN);
    this.grfY = this.heelF + this.toeF;
    this.grfX = lam(idx.heelT) + lam(idx.toeT);
    if (this.grfY > 1) {
      const mb = this.mb;
      mb.worldPoint(B.foot, GEO.heel[0], GEO.heel[1], this.p);
      const hx = this.p[0];
      mb.worldPoint(B.foot, GEO.toe[0], GEO.toe[1], this.p);
      const tx = this.p[0];
      this.copX = (this.heelF * hx + this.toeF * tx) / this.grfY;
    }
    this.barFloorF = lam(idx.barN);
    this.pinF = lam(idx.pinN);
    this.gripFx = -lam(idx.gripX);
    this.gripFy = -lam(idx.gripY);
    this.gripDemand = Math.hypot(this.gripFx, this.gripFy);
    let cf = 0;
    for (const r of this.capsuleRows) cf += rows[r].lambda * inv;
    this.capsuleF = cf;
    let bf = 0;
    for (const r of this.bodyRows) bf += rows[r].lambda * inv;
    this.bodyFloorF = bf;
  }

  // ---------------------------------------------------------------- queries

  point(body: number, lx: number, ly: number): [number, number] {
    this.mb.worldPoint(body, lx, ly, this.p);
    return [this.p[0], this.p[1]];
  }

  barPos(): [number, number] {
    return [this.q[BAR_DOF], this.q[BAR_DOF + 1]];
  }

  barVel(): [number, number] {
    return [this.qd[BAR_DOF], this.qd[BAR_DOF + 1]];
  }

  /** Is the bar weight carried by the lifter (attached and not resting on floor/pins)? */
  barSupported(): boolean {
    return this.barMode !== 'free' && this.barFloorF < 5 && this.pinF < 5;
  }

  private readonly bodyList = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  /** Centre of mass of lifter (+ bar when carried). Returns [x, y, vx]. */
  com(includeBar = true): [number, number, number] {
    const mb = this.mb;
    let mx = 0,
      my = 0,
      mvx = 0,
      mt = 0;
    for (const b of this.bodyList) {
      const s = mb.specs[b];
      mb.worldPoint(b, s.com[0], s.com[1], this.p);
      mb.pointVel(b, this.p[0], this.p[1], this.p2);
      mx += s.mass * this.p[0];
      my += s.mass * this.p[1];
      mvx += s.mass * this.p2[0];
      mt += s.mass;
    }
    if (includeBar && this.barSupported()) {
      const m = this.barMass;
      mx += m * this.q[BAR_DOF];
      my += m * this.q[BAR_DOF + 1];
      mvx += m * this.qd[BAR_DOF];
      mt += m;
    }
    return [mx / mt, my / mt, mvx / mt];
  }

  footEdges(): [number, number] {
    this.mb.worldPoint(B.foot, GEO.heel[0], GEO.heel[1], this.p);
    const h = this.p[0];
    this.mb.worldPoint(B.foot, GEO.toe[0], GEO.toe[1], this.p);
    return [h, this.p[0]];
  }
}
