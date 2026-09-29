import { JI, NJ, JOINT_INFO, type JointName } from './body.ts';
import { DEG } from '../physics/linalg.ts';

/**
 * Hill-type muscle groups acting on joints through angle-dependent moment arms.
 * Moment arm sign: positive = produces flexion (dorsiflexion / shoulder elevation).
 * Muscle–tendon length follows from ∫ r dθ, so fibre length and velocity are consistent with the joints.
 */

export const MUSCLE_IDS = [
  'calves',
  'quads',
  'hamstrings',
  'glutes',
  'core',
  'erectors',
  'lats',
  'traps',
  'delts',
  'biceps',
  'triceps',
  'grip',
  'tibialis',
  'iliopsoas',
] as const;
export type MuscleId = (typeof MUSCLE_IDS)[number];
export const MI = Object.fromEntries(MUSCLE_IDS.map((m, i) => [m, i])) as Record<MuscleId, number>;
export const NM = MUSCLE_IDS.length;

interface ArmSpec {
  joint: JointName;
  table: [number, number][];
}

export interface MuscleSpec {
  id: MuscleId;
  cn: string;
  en: string;
  region: 'legs' | 'trunk' | 'arms';
  fmax: number;
  leff: number;
  vmax: number;
  arms: ArmSpec[];
  ref: Partial<Record<JointName, number>>;
  role: string;
}

export const MUSCLES: MuscleSpec[] = [
  {
    id: 'calves', cn: '小腿三头肌', en: 'Calves', region: 'legs', fmax: 9000, leff: 0.07, vmax: 14,
    arms: [
      { joint: 'ankle', table: [[-50, -0.045], [0, -0.052], [30, -0.05], [42, -0.048]] },
      { joint: 'knee', table: [[0, 0.015], [90, 0.01], [150, 0.005]] },
    ],
    ref: { ankle: 10, knee: 0 },
    role: '踝跖屈：稳定前后平衡；高翻二次发力时踮脚（三关节伸展）',
  },
  {
    id: 'quads', cn: '股四头肌', en: 'Quadriceps', region: 'legs', fmax: 16000, leff: 0.14, vmax: 15,
    arms: [{ joint: 'knee', table: [[0, -0.04], [30, -0.048], [60, -0.046], [90, -0.041], [120, -0.034], [155, -0.028]] }],
    ref: { knee: 82 },
    role: '伸膝主力：深蹲起身、硬拉离地（“蹬地”）',
  },
  {
    id: 'hamstrings', cn: '腘绳肌', en: 'Hamstrings', region: 'legs', fmax: 6500, leff: 0.18, vmax: 15,
    arms: [
      { joint: 'hip', table: [[-25, -0.055], [0, -0.062], [60, -0.068], [120, -0.06]] },
      { joint: 'knee', table: [[0, 0.03], [45, 0.034], [90, 0.03], [150, 0.02]] },
    ],
    ref: { hip: 70, knee: 40 },
    role: '双关节肌：伸髋 + 屈膝。硬拉/罗马尼亚硬拉中被拉长并发力',
  },
  {
    id: 'glutes', cn: '臀大肌', en: 'Glutes + adductors', region: 'legs', fmax: 9000, leff: 0.2, vmax: 15,
    arms: [{ joint: 'hip', table: [[-25, -0.058], [0, -0.064], [45, -0.07], [90, -0.07], [140, -0.064]] }],
    ref: { hip: 75 },
    role: '伸髋主力（含内收大肌）：深蹲出底、硬拉锁定“顶髋”',
  },
  {
    id: 'core', cn: '核心腹肌', en: 'Core / Abs', region: 'trunk', fmax: 2500, leff: 0.1, vmax: 10,
    arms: [
      { joint: 'lumbar', table: [[0, 0.085]] },
      { joint: 'thoracic', table: [[0, 0.03]] },
    ],
    ref: { lumbar: 0, thoracic: 0 },
    role: '腹内压 + 共收缩：支撑脊柱刚度（“收紧核心”）',
  },
  {
    id: 'erectors', cn: '竖脊肌', en: 'Erector spinae', region: 'trunk', fmax: 11000, leff: 0.1, vmax: 8,
    arms: [
      { joint: 'lumbar', table: [[0, -0.06]] },
      { joint: 'thoracic', table: [[0, -0.012]] },
    ],
    ref: { lumbar: 15, thoracic: 10 },
    role: '伸脊柱：等长收缩保持背部中立，防止弓腰',
  },
  {
    id: 'lats', cn: '背阔肌', en: 'Latissimus', region: 'trunk', fmax: 3200, leff: 0.14, vmax: 10,
    arms: [
      { joint: 'shoulder', table: [[-60, -0.03], [0, -0.04], [90, -0.04], [180, -0.025]] },
      { joint: 'lumbar', table: [[0, -0.015]] },
      { joint: 'shrug', table: [[0, -0.15]] },
    ],
    ref: { shoulder: 45, lumbar: 0, shrug: 0.01 },
    role: '肩伸：把杠铃“扫”向身体，保持杠铃贴腿',
  },
  {
    id: 'traps', cn: '斜方肌', en: 'Trapezius', region: 'trunk', fmax: 2200, leff: 0.1, vmax: 10,
    arms: [
      { joint: 'shrug', table: [[0, 1.0]] },
      { joint: 'thoracic', table: [[0, -0.035]] },
    ],
    ref: { shrug: 0.02, thoracic: 0 },
    role: '耸肩 + 上背伸展：高翻二次发力末端“耸肩”',
  },
  {
    id: 'delts', cn: '三角肌', en: 'Deltoids', region: 'arms', fmax: 3800, leff: 0.1, vmax: 10,
    arms: [{ joint: 'shoulder', table: [[-60, 0.015], [0, 0.025], [60, 0.035], [120, 0.03], [180, 0.02]] }],
    ref: { shoulder: 40 },
    role: '肩屈：高翻翻腕架杠时抬肘',
  },
  {
    id: 'biceps', cn: '肱二头肌', en: 'Biceps', region: 'arms', fmax: 3800, leff: 0.12, vmax: 10,
    arms: [
      { joint: 'elbow', table: [[0, 0.025], [45, 0.038], [90, 0.042], [150, 0.03]] },
      { joint: 'shoulder', table: [[0, 0.012]] },
    ],
    ref: { elbow: 80, shoulder: 0 },
    role: '屈肘：高翻“拉身入杠”（硬拉时应放松，手臂只是挂钩）',
  },
  {
    id: 'triceps', cn: '肱三头肌', en: 'Triceps', region: 'arms', fmax: 5500, leff: 0.16, vmax: 10,
    arms: [
      { joint: 'elbow', table: [[0, -0.02], [90, -0.022], [150, -0.018]] },
      { joint: 'shoulder', table: [[0, -0.015]] },
    ],
    ref: { elbow: 80, shoulder: 0 },
    role: '伸肘：锁定手臂',
  },
  {
    id: 'grip', cn: '握力', en: 'Grip', region: 'arms', fmax: 3400, leff: 0.1, vmax: 10,
    arms: [],
    ref: {},
    role: '前臂屈肌：握力不足时杠铃会从手中滑脱',
  },
  {
    id: 'tibialis', cn: '胫骨前肌', en: 'Tibialis ant.', region: 'legs', fmax: 2800, leff: 0.08, vmax: 10,
    arms: [{ joint: 'ankle', table: [[-50, 0.035], [0, 0.04], [42, 0.042]] }],
    ref: { ankle: 0 },
    role: '踝背屈：重心偏后时把身体拉回来',
  },
  {
    id: 'iliopsoas', cn: '屈髋肌群', en: 'Hip flexors', region: 'legs', fmax: 6000, leff: 0.12, vmax: 10,
    arms: [{ joint: 'hip', table: [[-25, 0.03], [0, 0.035], [60, 0.04], [140, 0.028]] }],
    ref: { hip: 40 },
    role: '屈髋：主动下蹲、高翻快速下蹲接杠',
  },
];

class MomentArm {
  readonly joint: number;
  readonly xs: Float64Array;
  readonly rs: Float64Array;
  readonly cum: Float64Array;

  constructor(joint: JointName, table: [number, number][]) {
    this.joint = JI[joint];
    const linear = JOINT_INFO[this.joint].linear;
    const k = linear ? 1 : DEG;
    this.xs = Float64Array.from(table.map((t) => t[0] * k));
    this.rs = Float64Array.from(table.map((t) => t[1]));
    this.cum = new Float64Array(table.length);
    for (let i = 1; i < table.length; i++)
      this.cum[i] = this.cum[i - 1] + 0.5 * (this.rs[i] + this.rs[i - 1]) * (this.xs[i] - this.xs[i - 1]);
  }

  r(x: number): number {
    const { xs, rs } = this;
    const m = xs.length;
    if (x <= xs[0]) return rs[0];
    if (x >= xs[m - 1]) return rs[m - 1];
    let i = 1;
    while (xs[i] < x) i++;
    const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return rs[i - 1] + t * (rs[i] - rs[i - 1]);
  }

  /** ∫ r dx from xs[0] to x. */
  integral(x: number): number {
    const { xs, rs, cum } = this;
    const m = xs.length;
    if (x <= xs[0]) return (x - xs[0]) * rs[0];
    if (x >= xs[m - 1]) return cum[m - 1] + (x - xs[m - 1]) * rs[m - 1];
    let i = 1;
    while (xs[i] < x) i++;
    const r = this.r(x);
    return cum[i - 1] + 0.5 * (rs[i - 1] + r) * (x - xs[i - 1]);
  }
}

const FL_W = 0.5;
const PE_K = 4,
  PE_E0 = 0.6,
  PE_DEN = Math.exp(PE_K) - 1;

export function forceLength(lt: number): number {
  const d = (lt - 1) / FL_W;
  return Math.exp(-d * d);
}

export function forcePassive(lt: number): number {
  if (lt <= 1) return 0;
  const f = (Math.exp((PE_K * (lt - 1)) / PE_E0) - 1) / PE_DEN;
  return f > 2.5 ? 2.5 : f;
}

export function forceVelocity(vt: number): number {
  if (vt <= 0) {
    if (vt <= -1) return 0;
    return (1 + vt) / (1 - vt / 0.3);
  }
  return 1 + 0.8 * (1 - Math.exp(-12.5 * vt));
}

export class MuscleSet {
  readonly specs = MUSCLES;
  readonly n = NM;
  readonly arms: MomentArm[][];
  readonly refLen: Float64Array;
  /** Neural excitation (input) and activation (state), 0..1. */
  readonly u = new Float64Array(NM);
  readonly a = new Float64Array(NM);
  readonly force = new Float64Array(NM);
  readonly lt = new Float64Array(NM);
  readonly vt = new Float64Array(NM);
  readonly fl = new Float64Array(NM);
  readonly fv = new Float64Array(NM);
  readonly fpe = new Float64Array(NM);
  /** Anatomical torque per unit activation, [joint * NM + muscle]. */
  readonly gain = new Float64Array(NJ * NM);
  /** Moment arms, [joint * NM + muscle]. */
  readonly r = new Float64Array(NJ * NM);
  readonly passiveTorque = new Float64Array(NJ);
  readonly torque = new Float64Array(NJ);
  /** Per-muscle joint torque contribution, [joint * NM + muscle]. */
  readonly contrib = new Float64Array(NJ * NM);
  tauAct = 0.012;
  tauDeact = 0.045;

  constructor() {
    this.arms = MUSCLES.map((m) => m.arms.map((a) => new MomentArm(a.joint, a.table)));
    this.refLen = new Float64Array(NM);
    MUSCLES.forEach((m, i) => {
      let s = 0;
      this.arms[i].forEach((arm) => {
        const info = JOINT_INFO[arm.joint];
        const raw = m.ref[info.name] ?? 0;
        const x = info.linear ? raw : raw * DEG;
        s += arm.integral(x);
      });
      this.refLen[i] = s;
    });
  }

  updateActivation(dt: number): void {
    const { u, a } = this;
    for (let i = 0; i < NM; i++) {
      const ui = u[i] < 0 ? 0 : u[i] > 1 ? 1 : u[i];
      const tau = ui > a[i] ? this.tauAct * (0.5 + 1.5 * a[i]) : this.tauDeact / (0.5 + 1.5 * a[i]);
      a[i] += ((ui - a[i]) * dt) / Math.max(tau, dt);
      if (a[i] < 0) a[i] = 0;
      else if (a[i] > 1) a[i] = 1;
    }
  }

  compute(anat: Float64Array, anatVel: Float64Array): void {
    const { gain, r, torque, passiveTorque, contrib } = this;
    torque.fill(0);
    passiveTorque.fill(0);
    gain.fill(0);
    r.fill(0);
    contrib.fill(0);
    for (let i = 0; i < NM; i++) {
      const spec = MUSCLES[i];
      const arms = this.arms[i];
      if (arms.length === 0) {
        this.lt[i] = 1;
        this.vt[i] = 0;
        this.fl[i] = 1;
        this.fv[i] = 1;
        this.fpe[i] = 0;
        this.force[i] = spec.fmax * this.a[i];
        continue;
      }
      let integ = 0,
        ldot = 0;
      for (const arm of arms) {
        const x = anat[arm.joint];
        const ri = arm.r(x);
        r[arm.joint * NM + i] = ri;
        integ += arm.integral(x);
        ldot -= ri * anatVel[arm.joint];
      }
      const dl = -(integ - this.refLen[i]);
      const lt = 1 + dl / spec.leff;
      const vt = ldot / (spec.vmax * spec.leff);
      const fl = forceLength(lt);
      const fv = forceVelocity(vt);
      const fpe = forcePassive(lt);
      this.lt[i] = lt;
      this.vt[i] = vt;
      this.fl[i] = fl;
      this.fv[i] = fv;
      this.fpe[i] = fpe;
      const g = spec.fmax * fl * fv;
      const F = g * this.a[i] + spec.fmax * fpe;
      this.force[i] = F;
      for (const arm of arms) {
        const j = arm.joint;
        const ri = r[j * NM + i];
        gain[j * NM + i] = ri * g;
        passiveTorque[j] += ri * spec.fmax * fpe;
        contrib[j * NM + i] = ri * F;
        torque[j] += ri * F;
      }
    }
  }

  reset(): void {
    this.u.fill(0);
    this.a.fill(0);
  }
}
