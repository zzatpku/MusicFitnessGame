/**
 * Planar (sagittal-plane) articulated multibody dynamics in generalized coordinates.
 *
 * Each body has a local frame (x forward, y up when its angle is 0). A body is attached to its
 * parent through a joint located at `pParent` (parent frame) and `pChild` (child frame).
 * Equations of motion are assembled from point Jacobians:
 *   M(q) q̈ + h(q, q̇) = Q,   M = Σ m Jcᵀ Jc + I Jωᵀ Jω,   h = Σ m Jcᵀ (J̇c q̇ − g)
 */

export type JointKind = 'free' | 'fixed' | 'revolute' | 'prismatic';

export interface BodySpec {
  name: string;
  parent: number;
  joint: JointKind;
  pParent: readonly [number, number];
  pChild: readonly [number, number];
  axis?: readonly [number, number];
  mass: number;
  com: readonly [number, number];
  inertia: number;
}

export interface PointMass {
  body: number;
  lx: number;
  ly: number;
  mass: number;
}

export class Multibody {
  readonly specs: BodySpec[];
  readonly nb: number;
  readonly n: number;
  readonly dof0: Int32Array;
  readonly angular: Uint8Array;
  readonly chain: number[][];
  readonly chainDofs: number[][];

  readonly q: Float64Array;
  readonly qd: Float64Array;
  readonly th: Float64Array;
  readonly om: Float64Array;
  readonly ox: Float64Array;
  readonly oy: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly jx: Float64Array;
  readonly jy: Float64Array;
  readonly jvx: Float64Array;
  readonly jvy: Float64Array;
  readonly axx: Float64Array;
  readonly axy: Float64Array;
  readonly omp: Float64Array;
  /** Pose for bodies with a fixed joint to the world: [x, y, θ] of the joint point. */
  readonly rootPose: Float64Array;
  readonly M: Float64Array;
  readonly h: Float64Array;
  extra: PointMass[] = [];
  gravity = 9.81;

  private readonly Jx: Float64Array;
  private readonly Jy: Float64Array;
  private readonly tmp2 = new Float64Array(2);

  constructor(specs: BodySpec[]) {
    this.specs = specs;
    const nb = specs.length;
    this.nb = nb;
    const dof0 = new Int32Array(nb).fill(-1);
    const ang: number[] = [];
    let n = 0;
    specs.forEach((s, b) => {
      if (s.parent >= b) throw new Error(`Body ${s.name} must come after its parent`);
      if (s.joint === 'free') {
        dof0[b] = n;
        n += 3;
        ang.push(0, 0, 1);
      } else if (s.joint === 'revolute') {
        dof0[b] = n;
        n += 1;
        ang.push(1);
      } else if (s.joint === 'prismatic') {
        dof0[b] = n;
        n += 1;
        ang.push(0);
      }
    });
    this.n = n;
    this.dof0 = dof0;
    this.angular = Uint8Array.from(ang);
    this.chain = [];
    this.chainDofs = [];
    for (let b = 0; b < nb; b++) {
      const c: number[] = [];
      const d: number[] = [];
      let a = b;
      while (a >= 0) {
        if (dof0[a] >= 0) {
          c.push(a);
          const k = specs[a].joint === 'free' ? 3 : 1;
          for (let i = 0; i < k; i++) d.push(dof0[a] + i);
        }
        a = specs[a].parent;
      }
      this.chain.push(c);
      this.chainDofs.push(d.sort((x, y) => x - y));
    }
    const f = () => new Float64Array(nb);
    this.q = new Float64Array(n);
    this.qd = new Float64Array(n);
    this.th = f();
    this.om = f();
    this.ox = f();
    this.oy = f();
    this.vx = f();
    this.vy = f();
    this.jx = f();
    this.jy = f();
    this.jvx = f();
    this.jvy = f();
    this.axx = f();
    this.axy = f();
    this.omp = f();
    this.rootPose = new Float64Array(nb * 3);
    this.M = new Float64Array(n * n);
    this.h = new Float64Array(n);
    this.Jx = new Float64Array(n);
    this.Jy = new Float64Array(n);
  }

  setState(q: ArrayLike<number>, qd: ArrayLike<number>): void {
    for (let i = 0; i < this.n; i++) {
      this.q[i] = q[i];
      this.qd[i] = qd[i];
    }
    this.kinematics();
  }

  kinematics(): void {
    const { specs, q, qd, th, om, ox, oy, vx, vy, jx, jy, jvx, jvy } = this;
    for (let b = 0; b < this.nb; b++) {
      const s = specs[b];
      const p = s.parent;
      let thp = 0,
        omp = 0,
        opx = 0,
        opy = 0,
        vpx = 0,
        vpy = 0;
      if (p >= 0) {
        thp = th[p];
        omp = om[p];
        opx = ox[p];
        opy = oy[p];
        vpx = vx[p];
        vpy = vy[p];
      }
      this.omp[b] = omp;
      const d = this.dof0[b];
      const cp = Math.cos(thp),
        sp = Math.sin(thp);
      const pP = s.pParent,
        pC = s.pChild;
      if (s.joint === 'free') {
        th[b] = q[d + 2];
        om[b] = qd[d + 2];
        ox[b] = q[d];
        oy[b] = q[d + 1];
        vx[b] = qd[d];
        vy[b] = qd[d + 1];
        jx[b] = ox[b];
        jy[b] = oy[b];
        jvx[b] = vx[b];
        jvy[b] = vy[b];
        continue;
      }
      let Px: number, Py: number, vPx: number, vPy: number, t: number, w: number;
      if (s.joint === 'fixed' && p < 0) {
        Px = this.rootPose[3 * b];
        Py = this.rootPose[3 * b + 1];
        t = this.rootPose[3 * b + 2];
        vPx = 0;
        vPy = 0;
        w = 0;
      } else if (s.joint === 'prismatic') {
        const ax = s.axis![0],
          ay = s.axis![1];
        const wax = cp * ax - sp * ay,
          way = sp * ax + cp * ay;
        this.axx[b] = wax;
        this.axy[b] = way;
        const lx = pP[0] + ax * q[d],
          ly = pP[1] + ay * q[d];
        Px = opx + cp * lx - sp * ly;
        Py = opy + sp * lx + cp * ly;
        vPx = vpx - omp * (Py - opy) + wax * qd[d];
        vPy = vpy + omp * (Px - opx) + way * qd[d];
        t = thp;
        w = omp;
      } else {
        Px = opx + cp * pP[0] - sp * pP[1];
        Py = opy + sp * pP[0] + cp * pP[1];
        vPx = vpx - omp * (Py - opy);
        vPy = vpy + omp * (Px - opx);
        if (s.joint === 'revolute') {
          t = thp + q[d];
          w = omp + qd[d];
        } else {
          t = thp;
          w = omp;
        }
      }
      th[b] = t;
      om[b] = w;
      const c = Math.cos(t),
        sn = Math.sin(t);
      const oxb = Px - (c * pC[0] - sn * pC[1]);
      const oyb = Py - (sn * pC[0] + c * pC[1]);
      ox[b] = oxb;
      oy[b] = oyb;
      vx[b] = vPx - w * (oyb - Py);
      vy[b] = vPy + w * (oxb - Px);
      jx[b] = Px;
      jy[b] = Py;
      jvx[b] = vPx;
      jvy[b] = vPy;
    }
  }

  worldPoint(b: number, lx: number, ly: number, out: Float64Array | number[]): void {
    const c = Math.cos(this.th[b]),
      s = Math.sin(this.th[b]);
    out[0] = this.ox[b] + c * lx - s * ly;
    out[1] = this.oy[b] + s * lx + c * ly;
  }

  pointVel(b: number, wx: number, wy: number, out: Float64Array | number[]): void {
    out[0] = this.vx[b] - this.om[b] * (wy - this.oy[b]);
    out[1] = this.vy[b] + this.om[b] * (wx - this.ox[b]);
  }

  /** Fill dense rows Jx, Jy (length n) with the Jacobian of world point (wx, wy) rigidly attached to body b. */
  jacobian(b: number, wx: number, wy: number, Jx: Float64Array, Jy: Float64Array): void {
    Jx.fill(0);
    Jy.fill(0);
    for (const a of this.chain[b]) {
      const d = this.dof0[a];
      const j = this.specs[a].joint;
      if (j === 'free') {
        Jx[d] = 1;
        Jy[d + 1] = 1;
        Jx[d + 2] = -(wy - this.oy[a]);
        Jy[d + 2] = wx - this.ox[a];
      } else if (j === 'revolute') {
        Jx[d] = -(wy - this.jy[a]);
        Jy[d] = wx - this.jx[a];
      } else if (j === 'prismatic') {
        Jx[d] = this.axx[a];
        Jy[d] = this.axy[a];
      }
    }
  }

  /** Velocity-product acceleration J̇ q̇ of a world point attached to body b. */
  accBias(b: number, wx: number, wy: number, out: Float64Array | number[]): void {
    const pv = this.tmp2;
    this.pointVel(b, wx, wy, pv);
    let ax = 0,
      ay = 0;
    for (const a of this.chain[b]) {
      const d = this.dof0[a];
      const j = this.specs[a].joint;
      if (j === 'free') {
        const w = this.qd[d + 2];
        ax += -w * (pv[1] - this.vy[a]);
        ay += w * (pv[0] - this.vx[a]);
      } else if (j === 'revolute') {
        const w = this.qd[d];
        ax += -w * (pv[1] - this.jvy[a]);
        ay += w * (pv[0] - this.jvx[a]);
      } else if (j === 'prismatic') {
        const w = this.qd[d] * this.omp[a];
        ax += -w * this.axy[a];
        ay += w * this.axx[a];
      }
    }
    out[0] = ax;
    out[1] = ay;
  }

  dynamics(): void {
    this.M.fill(0);
    this.h.fill(0);
    for (let b = 0; b < this.nb; b++) {
      const s = this.specs[b];
      if (s.mass > 0) this.addMass(b, s.com[0], s.com[1], s.mass, s.inertia);
    }
    for (const pm of this.extra) if (pm.mass > 0) this.addMass(pm.body, pm.lx, pm.ly, pm.mass, 0);
  }

  private readonly wp = new Float64Array(2);
  private readonly ab = new Float64Array(2);

  private addMass(b: number, lx: number, ly: number, m: number, I: number): void {
    const { M, h, n, Jx, Jy, angular, wp, ab } = this;
    this.worldPoint(b, lx, ly, wp);
    this.jacobian(b, wp[0], wp[1], Jx, Jy);
    this.accBias(b, wp[0], wp[1], ab);
    const g = this.gravity;
    const dofs = this.chainDofs[b];
    for (let ii = 0; ii < dofs.length; ii++) {
      const i = dofs[ii];
      h[i] += m * (Jx[i] * ab[0] + Jy[i] * (ab[1] + g));
      const row = i * n;
      for (let kk = 0; kk < dofs.length; kk++) {
        const k = dofs[kk];
        M[row + k] += m * (Jx[i] * Jx[k] + Jy[i] * Jy[k]) + I * angular[i] * angular[k];
      }
    }
  }

  /** Total mass-weighted centre of mass over a subset of bodies (plus extra point masses). */
  com(bodies: number[] | null, out: Float64Array | number[], includeExtra = true): number {
    let mx = 0,
      my = 0,
      mt = 0;
    const p = this.wp;
    const list = bodies ?? [...Array(this.nb).keys()];
    for (const b of list) {
      const s = this.specs[b];
      if (s.mass <= 0) continue;
      this.worldPoint(b, s.com[0], s.com[1], p);
      mx += s.mass * p[0];
      my += s.mass * p[1];
      mt += s.mass;
    }
    if (includeExtra)
      for (const pm of this.extra) {
        this.worldPoint(pm.body, pm.lx, pm.ly, p);
        mx += pm.mass * p[0];
        my += pm.mass * p[1];
        mt += pm.mass;
      }
    out[0] = mx / mt;
    out[1] = my / mt;
    return mt;
  }
}
