import type { BodySpec } from '../physics/multibody.ts';
import { Multibody } from '../physics/multibody.ts';
import { DEG } from '../physics/linalg.ts';

/**
 * Sagittal-plane lifter model (1.78 m / 80 kg trained male). Left and right limbs move together,
 * so each limb segment carries the mass of both sides and each muscle group the force of both sides.
 *
 * Sign conventions: x = forward (the lifter faces +x), y = up, angles counter-clockwise.
 * "Anatomical" joint values: positive = flexion (dorsiflexion at the ankle, elevation for shrug).
 */

export const JOINTS = ['hip', 'knee', 'ankle', 'lumbar', 'thoracic', 'shrug', 'shoulder', 'elbow'] as const;
export type JointName = (typeof JOINTS)[number];
export const NJ = JOINTS.length;
export const JI: Record<JointName, number> = {
  hip: 0,
  knee: 1,
  ankle: 2,
  lumbar: 3,
  thoracic: 4,
  shrug: 5,
  shoulder: 6,
  elbow: 7,
};

export interface JointInfo {
  name: JointName;
  cn: string;
  simDof: number;
  simSign: number;
  ctrlDof: number;
  ctrlSign: number;
  min: number;
  max: number;
  linear?: boolean;
  pos: string;
  neg: string;
}

export const JOINT_INFO: JointInfo[] = [
  { name: 'hip', cn: '髋', simDof: 3, simSign: 1, ctrlDof: 2, ctrlSign: -1, min: -18 * DEG, max: 140 * DEG, pos: '屈', neg: '伸' },
  { name: 'knee', cn: '膝', simDof: 4, simSign: -1, ctrlDof: 1, ctrlSign: 1, min: -4 * DEG, max: 155 * DEG, pos: '屈', neg: '伸' },
  { name: 'ankle', cn: '踝', simDof: 5, simSign: 1, ctrlDof: 0, ctrlSign: -1, min: -50 * DEG, max: 45 * DEG, pos: '背屈', neg: '跖屈' },
  { name: 'lumbar', cn: '腰椎', simDof: 6, simSign: -1, ctrlDof: 3, ctrlSign: -1, min: -25 * DEG, max: 55 * DEG, pos: '屈', neg: '伸' },
  { name: 'thoracic', cn: '胸椎', simDof: 7, simSign: -1, ctrlDof: 4, ctrlSign: -1, min: -20 * DEG, max: 45 * DEG, pos: '屈', neg: '伸' },
  { name: 'shrug', cn: '耸肩', simDof: 8, simSign: 1, ctrlDof: 5, ctrlSign: 1, min: 0, max: 0.055, linear: true, pos: '上提', neg: '下沉' },
  { name: 'shoulder', cn: '肩', simDof: 9, simSign: 1, ctrlDof: 6, ctrlSign: 1, min: -60 * DEG, max: 185 * DEG, pos: '屈', neg: '伸' },
  { name: 'elbow', cn: '肘', simDof: 10, simSign: 1, ctrlDof: 7, ctrlSign: 1, min: 0, max: 150 * DEG, pos: '屈', neg: '伸' },
];

/** Body indices in the simulation tree (floating pelvis + free barbell). */
export const B = { pelvis: 0, thigh: 1, shank: 2, foot: 3, lumbar: 4, thorax: 5, girdle: 6, upperarm: 7, forearm: 8, bar: 9 } as const;
/** Body indices in the control tree (rooted at the foot). */
export const C = { foot: 0, shank: 1, thigh: 2, pelvis: 3, lumbar: 4, thorax: 5, girdle: 6, upperarm: 7, forearm: 8 } as const;
export const SIM_N = 14;
export const BAR_DOF = 11;

export const GEO = {
  ankleH: 0.08,
  heel: [-0.06, -0.08] as const,
  toe: [0.19, -0.08] as const,
  shank: 0.438,
  thigh: 0.436,
  l5s1: [-0.05, 0.1] as const,
  lumbar: 0.18,
  shoulder: [0.06, 0.25] as const,
  c7: [0, 0.3] as const,
  head: [0.035, 0.47] as const,
  upperArm: 0.33,
  wrist: 0.26,
  grip: 0.335,
  rackBack: [-0.09, 0.31] as const,
  rackFront: [0.16, 0.31] as const,
  midfoot: 0.065,
  shaftR: 0.0145,
  plateR: 0.225,
};

interface SegMass {
  m: number;
  com: readonly [number, number];
  I: number;
}

export const SEG: Record<string, SegMass> = {
  pelvis: { m: 11.36, com: [-0.02, 0.04], I: 0.11 },
  thigh: { m: 16.0, com: [0, -0.189], I: 0.317 },
  shank: { m: 7.44, com: [0, -0.19], I: 0.13 },
  foot: { m: 2.32, com: [0.06, -0.05], I: 0.038 },
  lumbar: { m: 11.12, com: [0.04, 0.09], I: 0.11 },
  thorax: { m: 22.56, com: [0.0457, 0.2419], I: 0.68 },
  girdle: { m: 1.2, com: [0, 0], I: 0.006 },
  upperarm: { m: 4.48, com: [0, -0.144], I: 0.0506 },
  forearm: { m: 3.52, com: [0, -0.1715], I: 0.051 },
};
export const BODY_MASS = Object.values(SEG).reduce((s, g) => s + g.m, 0);

const seg = (name: string) => ({ mass: SEG[name].m, com: SEG[name].com, inertia: SEG[name].I });

export function simSpecs(barMass: number, barInertia: number): BodySpec[] {
  return [
    { name: 'pelvis', parent: -1, joint: 'free', pParent: [0, 0], pChild: [0, 0], ...seg('pelvis') },
    { name: 'thigh', parent: 0, joint: 'revolute', pParent: [0, 0], pChild: [0, 0], ...seg('thigh') },
    { name: 'shank', parent: 1, joint: 'revolute', pParent: [0, -GEO.thigh], pChild: [0, 0], ...seg('shank') },
    { name: 'foot', parent: 2, joint: 'revolute', pParent: [0, -GEO.shank], pChild: [0, 0], ...seg('foot') },
    { name: 'lumbar', parent: 0, joint: 'revolute', pParent: GEO.l5s1, pChild: [0, 0], ...seg('lumbar') },
    { name: 'thorax', parent: 4, joint: 'revolute', pParent: [0, GEO.lumbar], pChild: [0, 0], ...seg('thorax') },
    { name: 'girdle', parent: 5, joint: 'prismatic', pParent: GEO.shoulder, pChild: [0, 0], axis: [0, 1], ...seg('girdle') },
    { name: 'upperarm', parent: 6, joint: 'revolute', pParent: [0, 0], pChild: [0, 0], ...seg('upperarm') },
    { name: 'forearm', parent: 7, joint: 'revolute', pParent: [0, -GEO.upperArm], pChild: [0, 0], ...seg('forearm') },
    { name: 'bar', parent: -1, joint: 'free', pParent: [0, 0], pChild: [0, 0], mass: barMass, com: [0, 0], inertia: barInertia },
  ];
}

export function ctrlSpecs(): BodySpec[] {
  return [
    { name: 'foot', parent: -1, joint: 'fixed', pParent: [0, 0], pChild: [0, 0], ...seg('foot') },
    { name: 'shank', parent: 0, joint: 'revolute', pParent: [0, 0], pChild: [0, -GEO.shank], ...seg('shank') },
    { name: 'thigh', parent: 1, joint: 'revolute', pParent: [0, 0], pChild: [0, -GEO.thigh], ...seg('thigh') },
    { name: 'pelvis', parent: 2, joint: 'revolute', pParent: [0, 0], pChild: [0, 0], ...seg('pelvis') },
    { name: 'lumbar', parent: 3, joint: 'revolute', pParent: GEO.l5s1, pChild: [0, 0], ...seg('lumbar') },
    { name: 'thorax', parent: 4, joint: 'revolute', pParent: [0, GEO.lumbar], pChild: [0, 0], ...seg('thorax') },
    { name: 'girdle', parent: 5, joint: 'prismatic', pParent: GEO.shoulder, pChild: [0, 0], axis: [0, 1], ...seg('girdle') },
    { name: 'upperarm', parent: 6, joint: 'revolute', pParent: [0, 0], pChild: [0, 0], ...seg('upperarm') },
    { name: 'forearm', parent: 7, joint: 'revolute', pParent: [0, -GEO.upperArm], pChild: [0, 0], ...seg('forearm') },
  ];
}

export type BarPlace = 'hands' | 'back' | 'front';

/** Anatomical pose (8 values, radians except shrug in metres). */
export type Pose = Float64Array;

export function makePose(p: Partial<Record<JointName, number>>, degrees = true): Pose {
  const out = new Float64Array(NJ);
  for (const info of JOINT_INFO) {
    const v = p[info.name] ?? 0;
    out[JI[info.name]] = info.linear || !degrees ? v : v * DEG;
  }
  return out;
}

/** Forward kinematics of an anatomical pose with the foot flat on the floor (ankle at x = footX). */
export class PoseFK {
  readonly mb = new Multibody(ctrlSpecs());
  private readonly zero = new Float64Array(8);
  private readonly qc = new Float64Array(8);
  readonly tmp = new Float64Array(2);

  set(pose: Pose, footX = 0, footTh = 0, ankleY = GEO.ankleH): void {
    const mb = this.mb;
    mb.rootPose[0] = footX;
    mb.rootPose[1] = ankleY;
    mb.rootPose[2] = footTh;
    for (const info of JOINT_INFO) this.qc[info.ctrlDof] = info.ctrlSign * pose[JI[info.name]];
    mb.setState(this.qc, this.zero);
  }

  point(body: number, lx: number, ly: number): [number, number] {
    this.mb.worldPoint(body, lx, ly, this.tmp);
    return [this.tmp[0], this.tmp[1]];
  }

  grip(): [number, number] {
    return this.point(C.forearm, 0, -GEO.grip);
  }

  rack(place: BarPlace): [number, number] {
    if (place === 'hands') return this.grip();
    const r = place === 'back' ? GEO.rackBack : GEO.rackFront;
    return this.point(C.thorax, r[0], r[1]);
  }

  /** COM of body (+ optional bar point mass). */
  com(barMass = 0, barAt: [number, number] | null = null): [number, number] {
    const out = this.tmp;
    const m = this.mb.com(null, out, false);
    let x = out[0] * m,
      y = out[1] * m,
      mt = m;
    if (barMass > 0 && barAt) {
      x += barAt[0] * barMass;
      y += barAt[1] * barMass;
      mt += barMass;
    }
    return [x / mt, y / mt];
  }

  angle(body: number): number {
    return this.mb.th[body];
  }

  /** Simulation coordinates for this pose (bar placed at `barPos`). */
  toSimQ(barPos: [number, number]): Float64Array {
    const q = new Float64Array(SIM_N);
    const mb = this.mb;
    q[0] = mb.ox[C.pelvis];
    q[1] = mb.oy[C.pelvis];
    q[2] = mb.th[C.pelvis];
    for (const info of JOINT_INFO) {
      const anat = info.ctrlSign * this.qc[info.ctrlDof];
      q[info.simDof] = info.simSign * anat;
    }
    q[BAR_DOF] = barPos[0];
    q[BAR_DOF + 1] = barPos[1];
    q[BAR_DOF + 2] = 0;
    return q;
  }
}
