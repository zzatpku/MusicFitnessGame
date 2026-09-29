import { NJ, type Pose, PoseFK } from './body.ts';
import type { RefSample } from './control.ts';

export interface Keyframe {
  t: number;
  pose: Pose;
  load: number;
}

/** Joint-space trajectory through keyframes using monotone (Fritsch–Carlson) cubic Hermite splines. */
export class Timeline {
  readonly keys: Keyframe[];
  readonly duration: number;
  private readonly tan: Float64Array[];

  constructor(keys: Keyframe[]) {
    this.keys = keys;
    this.duration = keys[keys.length - 1].t;
    const m = keys.length;
    this.tan = keys.map(() => new Float64Array(NJ));
    for (let j = 0; j < NJ; j++) {
      const d: number[] = [];
      for (let k = 0; k < m - 1; k++) d.push((keys[k + 1].pose[j] - keys[k].pose[j]) / Math.max(1e-6, keys[k + 1].t - keys[k].t));
      for (let k = 0; k < m; k++) {
        if (k === 0 || k === m - 1) this.tan[k][j] = 0;
        else if (d[k - 1] * d[k] <= 0) this.tan[k][j] = 0;
        else this.tan[k][j] = 0.5 * (d[k - 1] + d[k]);
      }
      for (let k = 0; k < m - 1; k++) {
        if (Math.abs(d[k]) < 1e-9) {
          this.tan[k][j] = 0;
          this.tan[k + 1][j] = 0;
          continue;
        }
        const a = this.tan[k][j] / d[k],
          b = this.tan[k + 1][j] / d[k];
        const s = a * a + b * b;
        if (s > 9) {
          const tau = 3 / Math.sqrt(s);
          this.tan[k][j] = tau * a * d[k];
          this.tan[k + 1][j] = tau * b * d[k];
        }
      }
    }
  }

  segment(t: number): number {
    const keys = this.keys;
    if (t <= keys[0].t) return 0;
    for (let k = 0; k < keys.length - 1; k++) if (t < keys[k + 1].t) return k;
    return keys.length - 2;
  }

  sample(t: number, out: RefSample): void {
    const keys = this.keys;
    const m = keys.length;
    if (t <= keys[0].t || t >= keys[m - 1].t) {
      const k = t <= keys[0].t ? keys[0] : keys[m - 1];
      out.q.set(k.pose);
      out.qd.fill(0);
      out.qdd.fill(0);
      out.load = k.load;
      return;
    }
    const k = this.segment(t);
    const k0 = keys[k],
      k1 = keys[k + 1];
    const h = k1.t - k0.t;
    const s = (t - k0.t) / h;
    const s2 = s * s,
      s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1,
      h10 = s3 - 2 * s2 + s,
      h01 = -2 * s3 + 3 * s2,
      h11 = s3 - s2;
    const d00 = 6 * s2 - 6 * s,
      d10 = 3 * s2 - 4 * s + 1,
      d01 = -6 * s2 + 6 * s,
      d11 = 3 * s2 - 2 * s;
    const a00 = 12 * s - 6,
      a10 = 6 * s - 4,
      a01 = -12 * s + 6,
      a11 = 6 * s - 2;
    const m0 = this.tan[k],
      m1 = this.tan[k + 1];
    for (let j = 0; j < NJ; j++) {
      const p0 = k0.pose[j],
        p1 = k1.pose[j];
      out.q[j] = h00 * p0 + h10 * h * m0[j] + h01 * p1 + h11 * h * m1[j];
      out.qd[j] = (d00 * p0 + d10 * h * m0[j] + d01 * p1 + d11 * h * m1[j]) / h;
      out.qdd[j] = (a00 * p0 + a10 * h * m0[j] + a01 * p1 + a11 * h * m1[j]) / (h * h);
    }
    out.load = k0.load + (k1.load - k0.load) * (s2 * (3 - 2 * s));
  }
}

/**
 * Solve for `unknowns` (joint indices) so that residual(fk) ≈ 0, via damped Gauss–Newton
 * with finite-difference Jacobians. Returns a new pose.
 */
export function solvePose(
  fk: PoseFK,
  base: Pose,
  unknowns: number[],
  residual: (fk: PoseFK, pose: Pose) => number[],
  footX = 0,
  iters = 120,
): Pose {
  const pose = Float64Array.from(base);
  const eps = 1e-6;
  const evalR = (p: Pose) => {
    fk.set(p, footX);
    return residual(fk, p);
  };
  const r2 = (v: number[]) => v.reduce((s, x) => s + x * x, 0);
  let r = evalR(pose);
  let e0 = r2(r);
  const n = unknowns.length;
  let lambda = 1e-3;
  for (let it = 0; it < iters && e0 > 1e-14; it++) {
    const m = r.length;
    const Jm: number[][] = [];
    for (let k = 0; k < n; k++) {
      const pp = Float64Array.from(pose);
      pp[unknowns[k]] += eps;
      const rp = evalR(pp);
      Jm.push(rp.map((v, i) => (v - r[i]) / eps));
    }
    const JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += Jm[a][i] * Jm[b][i];
        JtJ[a][b] = s;
      }
      let s = 0;
      for (let i = 0; i < m; i++) s += Jm[a][i] * r[i];
      g[a] = -s;
    }
    let improved = false;
    for (let tries = 0; tries < 12 && !improved; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-9 : v)));
      const dx = gaussSolve(A, g);
      const trial = Float64Array.from(pose);
      for (let k = 0; k < n; k++) trial[unknowns[k]] += clampStep(dx[k]);
      const rt = evalR(trial);
      const et = r2(rt);
      if (et < e0) {
        pose.set(trial);
        r = rt;
        e0 = et;
        lambda = Math.max(1e-7, lambda / 3);
        improved = true;
      } else lambda *= 4;
    }
    if (!improved) break;
  }
  fk.set(pose, footX);
  return pose;
}

const clampStep = (x: number) => Math.max(-0.25, Math.min(0.25, x));

/** Scalar root find by bisection on a bracket (f must change sign). */
export function bisect(f: (x: number) => number, lo: number, hi: number, iters = 40): number {
  let flo = f(lo);
  const fhi = f(hi);
  if (flo * fhi > 0) return Math.abs(flo) < Math.abs(fhi) ? lo : hi;
  for (let i = 0; i < iters; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if (fm * flo <= 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return 0.5 * (lo + hi);
}

function gaussSolve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}
