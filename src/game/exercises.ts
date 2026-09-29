import { BODY_MASS, C, GEO, JI, JOINT_INFO, NJ, PoseFK, ctrlSpecs, makePose, type BarPlace, type Pose } from '../sim/body.ts';
import { Multibody } from '../physics/multibody.ts';
import type { MuscleId } from '../sim/muscles.ts';
import { Timeline, solvePose, type Keyframe } from '../sim/reference.ts';
import { BAR_CAPSULES, type BarMode } from '../sim/world.ts';

export type ExerciseId = 'squat' | 'deadlift' | 'clean' | 'frontSquat' | 'rdl';
export type Difficulty = 'easy' | 'normal' | 'expert';
/** Musical role of each bar of a rep: build-up, full groove (the concentric effort), cool-down. */
export type Section = 'build' | 'drop' | 'rest';

export interface PhaseDef {
  id: string;
  t: number;
  cn: string;
  tip: string;
}

export interface ExercisePlan {
  timeline: Timeline;
  phases: PhaseDef[];
  startPose: Pose;
  startBar: [number, number];
  barMode: BarMode;
  /** Seconds per beat the plan was built for. */
  spb: number;
  /** Rep length in beats (a whole number of 4/4 bars). */
  repBeats: number;
  /** Clean only: earliest timeline time for the front-rack catch. */
  catchFrom?: number;
  /** Explosive window: balance reflex relaxed, heel raise allowed. */
  dynamic?: [number, number];
  /** Clean only: the racked bar is dropped onto the platform at this time. */
  dropAt?: number;
  /** The bar has to be put back to the start position before every rep. */
  resetEachRep: boolean;
}

export interface ExerciseDef {
  id: ExerciseId;
  cn: string;
  en: string;
  summary: string;
  focus: MuscleId[];
  barStart: BarPlace;
  barOnFloor: boolean;
  weight: { def: number; min: number; max: number };
  pins: number | null;
  /** Player-controlled muscles, most important first (the first 4 / 6 / 9 become the lanes). */
  lanes: MuscleId[];
  sections: Section[];
  build(barMass: number, spb: number): ExercisePlan;
}

const fk = new PoseFK();
const DEGR = Math.PI / 180;
const DEBUG_FEAS = !!(globalThis as { process?: { env?: Record<string, string> } }).process?.env?.DEBUG_FEAS;

// ------------------------------------------------------------------------------ pose helpers

const upperArmAngle = (f: PoseFK) => f.angle(C.upperarm);
const trunkLean = (f: PoseFK) => -f.angle(C.thorax);

/** Squat-family pose: given knee flexion, solve hip & ankle for COM over mid-foot with trunk lean ≈ c·shin angle. */
function squatPose(knee: number, c: number, place: BarPlace, barMass: number, arms: Record<string, number>, lumbar = 0, thoracic = 5): Pose {
  const base = makePose({ knee, hip: knee * 0.9, ankle: Math.min(35, knee * 0.28), lumbar, thoracic, ...arms });
  return solvePose(fk, base, [JI.ankle, JI.hip], (f, p) => {
    const com = f.com(barMass, f.rack(place));
    return [(com[0] - GEO.midfoot) * 10, trunkLean(f) - c * p[JI.ankle]];
  });
}

const SIM_TO_CTRL: Record<number, number> = { 2: C.shank, 1: C.thigh, 4: C.lumbar, 5: C.thorax };

/** Smallest bar-centre x at height y that keeps the bar clear of the legs/trunk in pose `f`. */
function barClearX(f: PoseFK, y: number): number {
  let best = -Infinity;
  for (const [body, ax, ay, bx, by, r] of BAR_CAPSULES) {
    const cb = SIM_TO_CTRL[body];
    const A = f.point(cb, ax, ay),
      Bp = f.point(cb, bx, by);
    if (y < Math.min(A[1], Bp[1]) - r || y > Math.max(A[1], Bp[1]) + r) continue;
    const dy = Bp[1] - A[1];
    const t = Math.abs(dy) < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (y - A[1]) / dy));
    const cx = A[0] + t * (Bp[0] - A[0]);
    const dyy = y - (A[1] + t * dy);
    best = Math.max(best, cx + Math.sqrt(Math.max(0, (r + GEO.shaftR + 0.004) ** 2 - dyy * dyy)));
  }
  return best;
}

/**
 * Bar-in-hands pose with the knee fixed: ankle, hip and shoulder put the grip on the bar at (bx, by)
 * with either a given arm angle from vertical, or (if `arm` is omitted) the COM over `comX`.
 * The bar is moved forward if it would intersect the legs.
 */
function pullPose(bx: number, by: number, fixed: Record<string, number>, opts: { arm?: number; barMass: number; comX?: number }): Pose {
  const solve = (x: number) =>
    solvePose(fk, makePose(fixed), [JI.ankle, JI.hip, JI.shoulder], (f) => {
      const g = f.grip();
      const r = [(g[0] - x) * 10, (g[1] - by) * 10];
      r.push(opts.arm !== undefined ? upperArmAngle(f) - opts.arm * DEGR : (f.com(opts.barMass, [x, by])[0] - (opts.comX ?? GEO.midfoot)) * 10);
      return r;
    });
  let x = bx;
  let p = solve(x);
  for (let i = 0; i < 4; i++) {
    fk.set(p);
    const clear = barClearX(fk, by);
    if (x >= clear - 1e-4) break;
    x = clear;
    p = solve(x);
  }
  return p;
}

/** Standing with the bar hanging in the hands against the front of the thighs, COM over mid-foot. */
function standWithBar(fixed: Record<string, number>, barMass: number): Pose {
  let pose = makePose(fixed);
  for (let i = 0; i < 4; i++) {
    fk.set(pose);
    const clear = barClearX(fk, fk.grip()[1]);
    pose = solvePose(fk, pose, [JI.ankle, JI.shoulder], (f) => {
      const g = f.grip();
      return [(f.com(barMass, g)[0] - GEO.midfoot) * 10, (g[0] - clear) * 10];
    });
  }
  return pose;
}

/** Re-solve the ankle so the COM (with the carried share of the bar at the grip) sits over mid-foot. */
function centred(p: Pose, barMass: number, load: number): Pose {
  return solvePose(fk, p, [JI.ankle], (f) => [(f.com(barMass * load, f.grip())[0] - GEO.midfoot) * 10]);
}

function withJ(p: Pose, mods: Record<string, number>): Pose {
  const out = Float64Array.from(p);
  for (const [name, v] of Object.entries(mods)) out[JI[name as keyof typeof JI]] = name === 'shrug' ? v : v * DEGR;
  return out;
}

// ------------------------------------------------------------------------------ dynamic feasibility

/**
 * Flat-footed feasibility: run inverse dynamics along the trajectory and lengthen any keyframe
 * segment whose implied centre of pressure leaves the foot (or whose vertical ground reaction
 * would drop too low). The result is the fastest timing the model can physically follow.
 */
function makeFeasible(
  keys: Keyframe[],
  barMass: number,
  placeOf: (seg: number) => BarPlace,
  explosive: (seg: number) => boolean = () => false,
  design: Keyframe[] = keys,
  fixed: (seg: number) => boolean = () => false,
  maxIter = 70,
): Keyframe[] {
  const mb = new Multibody(ctrlSpecs());
  const pm = { body: C.forearm as number, lx: 0, ly: -GEO.grip, mass: 0 };
  mb.extra = [pm];
  mb.rootPose[1] = GEO.ankleH;
  const q = new Float64Array(8),
    qd = new Float64Array(8),
    qdd = new Float64Array(8);
  const ref = { q: new Float64Array(NJ), qd: new Float64Array(NJ), qdd: new Float64Array(NJ), load: 1 };
  const lo = GEO.heel[0] + 0.025,
    hi = GEO.toe[0] - 0.035;
  const ankle = JOINT_INFO[JI.ankle].ctrlDof;
  let cur = keys.map((kf) => ({ ...kf }));
  const comY = (tl: Timeline, t: number, load: number, pl: BarPlace) => {
    tl.sample(t, ref);
    fk.set(ref.q);
    return fk.com(barMass * load, fk.rack(pl))[1];
  };
  for (let it = 0; it < maxIter; it++) {
    const tl = new Timeline(cur);
    const bad = new Set<number>();
    const h = 0.005;
    for (let t = h; t < tl.duration - h; t += h) {
      const seg = tl.segment(t);
      if (fixed(seg)) continue;
      const pl = placeOf(seg);
      tl.sample(t, ref);
      const load = ref.load;
      for (const info of JOINT_INFO) {
        const j = JI[info.name];
        q[info.ctrlDof] = info.ctrlSign * ref.q[j];
        qd[info.ctrlDof] = info.ctrlSign * ref.qd[j];
        qdd[info.ctrlDof] = info.ctrlSign * ref.qdd[j];
      }
      if (pl === 'hands') {
        pm.body = C.forearm;
        pm.lx = 0;
        pm.ly = -GEO.grip;
      } else {
        const r = pl === 'back' ? GEO.rackBack : GEO.rackFront;
        pm.body = C.thorax;
        pm.lx = r[0];
        pm.ly = r[1];
      }
      pm.mass = barMass * load;
      mb.setState(q, qd);
      mb.dynamics();
      let tauP = mb.h[ankle];
      for (let kk = 0; kk < 8; kk++) tauP += mb.M[ankle * 8 + kk] * qdd[kk];
      const ay = (comY(tl, t + h, load, pl) - 2 * comY(tl, t, load, pl) + comY(tl, t - h, load, pl)) / (h * h);
      const W = (BODY_MASS + pm.mass) * 9.81;
      const Fz = (BODY_MASS + pm.mass) * (9.81 + ay);
      const cop = Fz > 1 ? tauP / Fz : Infinity;
      const ex = explosive(seg);
      const l = ex ? GEO.heel[0] + 0.008 : lo,
        u = ex ? GEO.toe[0] - 0.004 : hi;
      if (!(cop > l && cop < u) || Fz < (ex ? 0.12 : 0.3) * W) {
        if (DEBUG_FEAS && !bad.has(seg)) console.log(`it${it} seg${seg} t=${t.toFixed(3)} cop=${cop.toFixed(3)} Fz/W=${(Fz / W).toFixed(2)} ex=${ex}`);
        bad.add(seg);
      }
    }
    if (!bad.size) break;
    const next = cur.map((kf) => ({ ...kf }));
    let shift = 0;
    for (let s = 0; s < cur.length - 1; s++) {
      const dur = cur[s + 1].t - cur[s].t;
      const orig = design[s + 1].t - design[s].t;
      const cap = explosive(s) ? 1.6 : 4;
      const nd = bad.has(s) ? Math.max(dur, Math.min(dur * 1.07, orig * cap)) : dur;
      shift += nd - dur;
      next[s + 1].t = cur[s + 1].t + shift;
    }
    cur = next;
    if (shift < 1e-9) break;
  }
  return cur;
}

// ------------------------------------------------------------------------------ plan assembly

/** A keyframe `beats` after the previous one (or `dt` seconds for the ballistic part of the clean). */
interface KeySpec {
  pose: Pose;
  beats?: number;
  dt?: number;
  load?: number;
  tag?: string;
}

interface PhaseSpec {
  at: string;
  id: string;
  cn: string;
  tip: string;
}

/**
 * Keys that follow a beat-timed segment are pushed later onto the 16th-note grid (never earlier),
 * so the phases of the lift land on the music. Seconds-timed segments keep their exact length.
 */
function snapToGrid(keys: Keyframe[], specs: KeySpec[], spb: number): Keyframe[] {
  const q = spb / 4;
  const out = keys.map((k) => ({ ...k }));
  let shift = 0;
  for (let k = 1; k < out.length; k++) {
    let t = keys[k].t + shift;
    if (specs[k].dt === undefined) {
      const ts = Math.ceil(t / q - 1e-6) * q;
      shift += ts - t;
      t = ts;
    }
    out[k].t = t;
  }
  return out;
}

function finalize(
  specs: KeySpec[],
  o: {
    barMass: number;
    spb: number;
    repBeats: number;
    barMode: BarMode;
    startBar: [number, number];
    place: (idx: number) => BarPlace;
    explosive?: (idx: number) => boolean;
    /** Segments owned by special session logic (ballistic pull-under, bar drop): never stretched. */
    fixed?: (idx: number) => boolean;
    phases: PhaseSpec[];
    catchFrom?: string;
    dynamic?: [string, string];
    dropAt?: string;
    resetEachRep?: boolean;
  },
): ExercisePlan {
  let t = 0;
  const raw: Keyframe[] = specs.map((s, i) => {
    t += i === 0 ? 0 : s.dt ?? (s.beats ?? 0) * o.spb;
    // The braced thoracic spine is modelled as very stiff; references use its rest angle.
    const pose = Float64Array.from(s.pose);
    pose[JI.thoracic] = 5 * DEGR;
    return { t, pose, load: s.load ?? 1 };
  });
  let keys = raw;
  for (let round = 0; round < 3; round++) {
    const feasible = makeFeasible(keys, o.barMass, o.place, o.explosive, raw, o.fixed);
    const snapped = snapToGrid(feasible, specs, o.spb);
    const moved = snapped.some((k, i) => Math.abs(k.t - keys[i].t) > 1e-6);
    keys = snapped;
    if (!moved) break;
  }
  const at = (tag: string) => {
    const i = specs.findIndex((s) => s.tag === tag);
    if (i < 0) throw new Error(`missing key tag ${tag}`);
    return keys[i].t;
  };
  const endBeats = keys[keys.length - 1].t / o.spb;
  return {
    timeline: new Timeline(keys),
    startPose: keys[0].pose,
    startBar: o.startBar,
    barMode: o.barMode,
    spb: o.spb,
    repBeats: Math.max(o.repBeats, Math.ceil(endBeats / 4 - 1e-6) * 4),
    catchFrom: o.catchFrom ? at(o.catchFrom) : undefined,
    dynamic: o.dynamic ? [at(o.dynamic[0]), at(o.dynamic[1])] : undefined,
    dropAt: o.dropAt ? at(o.dropAt) : undefined,
    resetEachRep: !!o.resetEachRep,
    phases: o.phases.map((p) => ({ id: p.id, t: at(p.at), cn: p.cn, tip: p.tip })),
  };
}

const BACK_ARMS = { shoulder: -35, elbow: 115, shrug: 0.008 };
const FRONT_ARMS = { shoulder: 80, elbow: 140, shrug: 0.01 };

// ------------------------------------------------------------------------------ exercises

/** Squat rep in two bars: brace (beat 1), descend through bar 1, hit the bottom on the downbeat of bar 2, drive up. */
function squatFamily(barMass: number, spb: number, place: 'back' | 'front', c: number, depth: number, arms: Record<string, number>, lumbarDeep: number, thoracic: number, phases: PhaseSpec[]): ExercisePlan {
  const pose = (kn: number) => squatPose(kn, c, place, barMass, arms, kn > 100 ? lumbarDeep : 1, thoracic);
  const stand = pose(3);
  fk.set(stand);
  const startBar = fk.rack(place);
  const specs: KeySpec[] = [
    { pose: stand, tag: 'setup' },
    { pose: stand, beats: 1, tag: 'go' },
    { pose: pose(60), beats: 1.25 },
    { pose: pose(100), beats: 0.75 },
    { pose: pose(depth), beats: 0.75, tag: 'bottom' },
    { pose: pose(depth), beats: 0.25, tag: 'drive' },
    { pose: pose(90), beats: 1 },
    { pose: pose(45), beats: 0.75 },
    { pose: stand, beats: 0.75, tag: 'lock' },
    { pose: stand, beats: 1.5 },
  ];
  return finalize(specs, { barMass, spb, repBeats: 8, barMode: place, startBar, place: () => place, phases });
}

const squat: ExerciseDef = {
  id: 'squat',
  cn: '深蹲',
  en: 'Back Squat',
  summary: '高杠位颈后深蹲。下蹲时股四头肌与臀大肌做离心收缩控制速度，出底时伸膝伸髋协同发力，竖脊肌与核心全程维持脊柱中立。',
  focus: ['quads', 'glutes', 'erectors', 'core'],
  barStart: 'back',
  barOnFloor: false,
  weight: { def: 60, min: 20, max: 200 },
  pins: 0.93,
  lanes: ['quads', 'glutes', 'erectors', 'core', 'calves', 'hamstrings', 'lats', 'tibialis', 'traps'],
  sections: ['build', 'drop'],
  build: (m, spb) =>
    squatFamily(m, spb, 'back', 1.4, 126, BACK_ARMS, 5, 6, [
      { at: 'setup', id: 'setup', cn: '准备', tip: '吸气憋住，收紧核心，杠铃稳稳压在斜方肌上' },
      { at: 'go', id: 'descent', cn: '下蹲 · 离心', tip: '股四头肌、臀大肌在被拉长的同时发力（离心收缩）控制下落速度' },
      { at: 'bottom', id: 'bottom', cn: '底部', tip: '大腿低于水平：臀大肌被充分拉长，股四头肌力臂变短，最吃力的位置' },
      { at: 'drive', id: 'ascent', cn: '起身 · 向心', tip: '伸膝 + 伸髋同时发力：若只伸膝会“撅屁股”，躯干前倾把压力甩给下背' },
      { at: 'lock', id: 'lockout', cn: '锁定', tip: '髋膝完全伸直，重心回到足中' },
    ]),
};

const frontSquat: ExerciseDef = {
  id: 'frontSquat',
  cn: '前蹲',
  en: 'Front Squat',
  summary: '杠铃架在三角肌前束上，躯干更直立，股四头肌和上背负担更大，髋部力矩更小。',
  focus: ['quads', 'erectors', 'core', 'glutes'],
  barStart: 'front',
  barOnFloor: false,
  weight: { def: 50, min: 20, max: 180 },
  pins: 0.84,
  lanes: ['quads', 'glutes', 'erectors', 'core', 'calves', 'traps', 'hamstrings', 'delts', 'tibialis'],
  sections: ['build', 'drop'],
  build: (m, spb) =>
    squatFamily(m, spb, 'front', 0.78, 124, FRONT_ARMS, 1, 3, [
      { at: 'setup', id: 'setup', cn: '准备', tip: '肘部抬高，杠铃压在三角肌前束，挺胸' },
      { at: 'go', id: 'descent', cn: '下蹲 · 离心', tip: '躯干保持直立，膝盖前移，股四头肌主导' },
      { at: 'bottom', id: 'bottom', cn: '底部', tip: '保持上背挺直（竖脊肌 + 斜方肌），别让手肘掉下来' },
      { at: 'drive', id: 'ascent', cn: '起身 · 向心', tip: '股四头肌强力伸膝，肘部领先' },
      { at: 'lock', id: 'lockout', cn: '锁定', tip: '站直，重心在足中' },
    ]),
};

const deadlift: ExerciseDef = {
  id: 'deadlift',
  cn: '硬拉',
  en: 'Deadlift',
  summary: '传统硬拉。离地阶段股四头肌“蹬地”，过膝后臀大肌与腘绳肌伸髋锁定；竖脊肌等长收缩维持背部平直，背阔肌把杠铃压向身体。',
  focus: ['glutes', 'hamstrings', 'erectors', 'quads', 'lats'],
  barStart: 'hands',
  barOnFloor: true,
  weight: { def: 100, min: 40, max: 260 },
  pins: null,
  lanes: ['glutes', 'hamstrings', 'quads', 'erectors', 'lats', 'core', 'traps', 'calves', 'tibialis'],
  sections: ['drop', 'rest'],
  build(barMass, spb) {
    const X = GEO.midfoot + 0.01;
    const setup = pullPose(X, GEO.plateR, { knee: 72, hip: 120, ankle: 10, lumbar: 3, thoracic: 6, shoulder: 60, elbow: 0, shrug: 0 }, { arm: -11, barMass });
    const kneeP = pullPose(X, 0.5, { knee: 32, hip: 75, ankle: 5, lumbar: 3, thoracic: 6, shoulder: 40, elbow: 0 }, { arm: -6, barMass });
    const thigh = pullPose(X + 0.005, 0.66, { knee: 18, hip: 45, ankle: 3, lumbar: 2, thoracic: 5, shoulder: 25, elbow: 0 }, { arm: -2, barMass });
    const lock = standWithBar({ knee: 3, hip: -1, ankle: 2, lumbar: -1, thoracic: 3, shoulder: 5, elbow: 0, shrug: 0.004 }, barMass);
    // Two bars: take the slack out, pull, lock out on the downbeat of bar 2, lower under control.
    return finalize(
      [
        { pose: setup, load: 0, tag: 'setup' },
        { pose: setup, beats: 0.5, load: 0, tag: 'tension' },
        { pose: setup, beats: 0.5, load: 1, tag: 'floor' },
        { pose: kneeP, beats: 1.25, tag: 'knee' },
        { pose: thigh, beats: 0.75 },
        { pose: lock, beats: 1, tag: 'lock' },
        { pose: lock, beats: 0.75, tag: 'lower' },
        { pose: thigh, beats: 1 },
        { pose: kneeP, beats: 0.75 },
        { pose: setup, beats: 0.75, load: 0.6 },
        { pose: setup, beats: 0.25, load: 0 },
      ],
      {
        barMass,
        spb,
        repBeats: 8,
        barMode: 'hands',
        startBar: [X, GEO.plateR],
        place: () => 'hands',
        phases: [
          { at: 'setup', id: 'setup', cn: '准备', tip: '杠铃在足中上方，小腿贴杠，肩略在杠前，背部平直' },
          { at: 'tension', id: 'tension', cn: '绷紧', tip: '“把杠铃的松弛拉掉”：背阔肌下压，全身预紧但杠铃还没离地' },
          { at: 'floor', id: 'floor', cn: '离地', tip: '像腿举一样“把地面推开”：股四头肌伸膝主导，背角保持不变' },
          { at: 'knee', id: 'knee', cn: '过膝', tip: '杠铃过膝后臀大肌 + 腘绳肌接管，伸髋把胯往前送' },
          { at: 'lock', id: 'lockout', cn: '锁定', tip: '臀部夹紧顶髋，不要后仰过度' },
          { at: 'lower', id: 'lower', cn: '下放', tip: '先送髋后屈膝，腘绳肌离心控制' },
        ],
      },
    );
  },
};

const rdl: ExerciseDef = {
  id: 'rdl',
  cn: '罗马尼亚硬拉',
  en: 'Romanian DL',
  summary: '从站立开始，膝盖微屈固定，髋关节向后折叠。腘绳肌在拉长状态下发力，是最能“感受”腘绳肌的动作。',
  focus: ['hamstrings', 'glutes', 'erectors'],
  barStart: 'hands',
  barOnFloor: false,
  weight: { def: 60, min: 20, max: 200 },
  pins: null,
  lanes: ['hamstrings', 'glutes', 'erectors', 'core', 'lats', 'quads', 'calves', 'traps', 'tibialis'],
  sections: ['build', 'drop'],
  build(barMass, spb) {
    const X = GEO.midfoot;
    const stand = standWithBar({ knee: 4, hip: 0, ankle: 2, lumbar: 0, thoracic: 3, shoulder: 5, elbow: 0, shrug: 0.004 }, barMass);
    const mid = pullPose(X, 0.62, { knee: 14, hip: 45, ankle: 2, lumbar: 2, thoracic: 5, shoulder: 30, elbow: 0 }, { barMass });
    const bottom = pullPose(X, 0.42, { knee: 18, hip: 88, ankle: 3, lumbar: 4, thoracic: 8, shoulder: 60, elbow: 0 }, { barMass });
    fk.set(stand);
    const startBar = fk.grip();
    // Two bars: hinge down through bar 1, reverse on the downbeat of bar 2.
    return finalize(
      [
        { pose: stand, tag: 'setup' },
        { pose: stand, beats: 1, tag: 'hinge' },
        { pose: mid, beats: 1.25 },
        { pose: bottom, beats: 1.5, tag: 'bottom' },
        { pose: bottom, beats: 0.25, tag: 'drive' },
        { pose: mid, beats: 1 },
        { pose: stand, beats: 1, tag: 'lock' },
        { pose: stand, beats: 2 },
      ],
      {
        barMass,
        spb,
        repBeats: 8,
        barMode: 'hands',
        startBar,
        place: () => 'hands',
        phases: [
          { at: 'setup', id: 'setup', cn: '准备', tip: '站直，杠铃贴大腿，膝盖微屈并保持' },
          { at: 'hinge', id: 'hinge', cn: '屈髋下放', tip: '臀部向后推，腘绳肌被拉长并做离心收缩' },
          { at: 'bottom', id: 'bottom', cn: '底部拉伸', tip: '腘绳肌张力最大；背部保持平直' },
          { at: 'drive', id: 'drive', cn: '伸髋起身', tip: '臀大肌 + 腘绳肌把髋往前送，杠铃贴腿上滑' },
          { at: 'lock', id: 'lockout', cn: '锁定', tip: '站直，臀部夹紧' },
        ],
      },
    );
  },
};

const clean: ExerciseDef = {
  id: 'clean',
  cn: '高翻',
  en: 'Power Clean',
  summary: '一拉离地 → 过膝进入发力位 → 二拉三关节（髋、膝、踝）爆发伸展 + 耸肩 → 快速下蹲拉身入杠 → 前架接杠 → 站起。考验发力顺序与时机。',
  focus: ['glutes', 'quads', 'calves', 'traps', 'hamstrings'],
  barStart: 'hands',
  barOnFloor: true,
  weight: { def: 60, min: 30, max: 150 },
  pins: null,
  lanes: ['quads', 'glutes', 'traps', 'hamstrings', 'calves', 'erectors', 'iliopsoas', 'delts', 'core'],
  sections: ['build', 'drop', 'rest'],
  build(barMass, spb) {
    const X = GEO.midfoot + 0.015;
    const setup = pullPose(X, GEO.plateR, { knee: 75, hip: 120, ankle: 12, lumbar: 2, thoracic: 6, shoulder: 60, elbow: 0, shrug: 0 }, { arm: -10, barMass });
    const kneeP = pullPose(X - 0.005, 0.5, { knee: 34, hip: 78, ankle: 5, lumbar: 2, thoracic: 5, shoulder: 45, elbow: 0 }, { arm: -8, barMass });
    const power = pullPose(X, 0.72, { knee: 24, hip: 40, ankle: 4, lumbar: 1, thoracic: 3, shoulder: 15, elbow: 0 }, { barMass, comX: GEO.midfoot + 0.01 });
    const ext = centred(withJ(power, { knee: 6, hip: 3, ankle: -6, lumbar: 0, thoracic: 2, shrug: 0.045, shoulder: 6, elbow: 12 }), barMass, 0.6);
    const under = centred(withJ(ext, { knee: 32, hip: 28, ankle: 10, lumbar: 0, thoracic: 3, shrug: 0.03, shoulder: -45, elbow: 130 }), barMass, 0.4);
    const preCatch = centred(withJ(ext, { knee: 48, hip: 40, ankle: 17, lumbar: 1, thoracic: 3, shrug: 0.02, shoulder: -55, elbow: 150 }), barMass, 0.4);
    const rackArms = { shoulder: 78, elbow: 140, shrug: 0.012 };
    const catchP = squatPose(58, 1.0, 'front', barMass, rackArms, 1, 3);
    const absorb = squatPose(70, 1.0, 'front', barMass, rackArms, 1, 3);
    const mid = squatPose(35, 0.7, 'front', barMass, rackArms, 0, 3);
    const stand = squatPose(3, 0.6, 'front', barMass, rackArms, 0, 3);
    const armsDown = centred(withJ(stand, { shoulder: 4, elbow: 8, shrug: 0 }), barMass, 0);
    // Three bars: slow first pull through bar 1, a fast scoop so the bar keeps accelerating, the
    // second pull explodes on the downbeat of bar 2, stand up with the bar racked, then drop it.
    const SCOOP = 0.25;
    const firstPull = (4 - 1.75) * spb - SCOOP;
    const specs: KeySpec[] = [
      { pose: setup, load: 0, tag: 'setup' },
      { pose: setup, beats: 1, load: 0, tag: 'tension' },
      { pose: setup, beats: 0.75, load: 1, tag: 'first' },
      { pose: kneeP, dt: firstPull, tag: 'knee' },
      { pose: power, dt: SCOOP, tag: 'power' },
      { pose: ext, dt: 0.32, load: 0.6, tag: 'ext' },
      { pose: under, dt: 0.29, load: 0.4 },
      { pose: preCatch, dt: 0.19, load: 0.4 },
      { pose: catchP, dt: 0.19, tag: 'catch' },
      { pose: absorb, beats: 0.25 },
      { pose: absorb, beats: 0.75, tag: 'recover' },
      { pose: mid, beats: 1 },
      { pose: stand, beats: 1, tag: 'lock' },
      { pose: stand, beats: 1.5, tag: 'drop' },
      { pose: armsDown, beats: 0.75, load: 0 },
      { pose: armsDown, beats: 0.5, load: 0 },
    ];
    const catchIdx = specs.findIndex((s) => s.tag === 'catch');
    const kneeIdx = specs.findIndex((s) => s.tag === 'knee');
    const powerIdx = specs.findIndex((s) => s.tag === 'power');
    const dropIdx = specs.findIndex((s) => s.tag === 'drop');
    return finalize(specs, {
      barMass,
      spb,
      repBeats: 12,
      barMode: 'hands',
      startBar: [X, GEO.plateR],
      place: (seg) => (seg >= catchIdx - 1 ? 'front' : 'hands'),
      explosive: (seg) => seg >= kneeIdx && seg < catchIdx,
      fixed: (seg) => (seg >= kneeIdx - 1 && seg <= catchIdx) || seg >= dropIdx,
      catchFrom: 'ext',
      dynamic: ['knee', 'recover'],
      dropAt: 'drop',
      resetEachRep: true,
      phases: [
        { at: 'setup', id: 'setup', cn: '准备', tip: '握距比硬拉宽，肩在杠前，背部平直' },
        { at: 'tension', id: 'tension', cn: '绷紧', tip: '全身预紧，背阔肌锁住杠铃' },
        { at: 'first', id: 'first', cn: '一拉', tip: '股四头肌伸膝把杠拉离地面，背角不变，杠铃向后贴腿' },
        { at: 'knee', id: 'scoop', cn: '过膝 · 发力位', tip: '杠铃过膝后贴大腿上滑，躯干抬起进入“发力位”，腘绳肌蓄力' },
        { at: 'power', id: 'second', cn: '二拉 · 三关节伸展', tip: '臀大肌 + 股四头肌 + 小腿爆发伸展，最后耸肩（斜方肌）' },
        { at: 'ext', id: 'under', cn: '下蹲 · 拉身入杠', tip: '放松腿部，屈髋屈膝快速下落；手臂（肱二头肌、三角肌）把身体拉到杠下' },
        { at: 'catch', id: 'catch', cn: '前架接杠', tip: '翻肘架杠，股四头肌与臀大肌离心缓冲' },
        { at: 'recover', id: 'recover', cn: '站起', tip: '前蹲站起，股四头肌主导' },
        { at: 'lock', id: 'lockout', cn: '完成', tip: '站稳，手肘抬高' },
        { at: 'drop', id: 'drop', cn: '放杠', tip: '杠铃向前推离身体，落在平台上，准备下一次' },
      ],
    });
  },
};

export const EXERCISES: ExerciseDef[] = [squat, deadlift, clean, frontSquat, rdl];
export const EXERCISE_MAP = Object.fromEntries(EXERCISES.map((e) => [e.id, e])) as Record<ExerciseId, ExerciseDef>;

/** Human-readable timing report of a plan (for diagnostics). */
export function describePlan(p: ExercisePlan): string {
  return p.phases.map((ph) => `${ph.cn}@${ph.t.toFixed(2)}`).join('  ');
}
