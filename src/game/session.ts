import { B, BAR_DOF, GEO, JI, PoseFK } from '../sim/body.ts';
import { MI, NM, type MuscleId } from '../sim/muscles.ts';
import { Autopilot, makeRefSample, type RefSample } from '../sim/control.ts';
import { LifterWorld } from '../sim/world.ts';
import { EXERCISE_MAP, type ExerciseDef, type ExerciseId, type ExercisePlan, type PhaseDef } from './exercises.ts';

export type RepState = 'ready' | 'lift' | 'success' | 'fail' | 'reset' | 'done';

/** Share of the coach's activation a player muscle keeps while its gate is closed (notes missed). */
export const GATE_FLOOR = 0.3;
/** Ankle muscles also carry the automatic balance reflex, so they never go fully limp. */
const FLOOR_OF = new Float64Array(NM).fill(GATE_FLOOR);
FLOOR_OF[MI.calves] = FLOOR_OF[MI.tibialis] = 0.5;
const GATE_UP = 0.03;
const GATE_DOWN = 0.3;
const PULSE_TAU = 0.12;

export interface RepResult {
  rep: number;
  ok: boolean;
  reason: string;
  form: number;
  details: string[];
  peakPower: number;
  time: number;
  bonus: number;
}

/** Per-rep tracking used for judging and form scoring. */
class RepTracker {
  t = 0;
  liftOff = false;
  reachedDepth = false;
  maxDepth = 0;
  maxLumbar = 0;
  copEdgeTime = 0;
  barDevSum = 0;
  barDevN = 0;
  peakPower = 0;
  racked = false;
  pinTime = 0;
  hipsFirst = 0;
  heelRaise = 0;
  maxBarY = 0;
}

/**
 * One lifter on the platform, driven by the song clock. Reps start on bar lines; within a rep the
 * reference timeline advances with the music. Muscles on player lanes fire at the coach's level
 * scaled by their gate (kept open by hitting that lane's notes); every other muscle is automatic.
 */
export class LiftSession {
  readonly world: LifterWorld;
  readonly fk = new PoseFK();
  ex!: ExerciseDef;
  plan!: ExercisePlan;
  weight = 60;
  bpm = 84;
  spb = 60 / 84;
  state: RepState = 'ready';
  /** Song time the physics has been advanced to (s). */
  time = 0;
  /** Timeline time within the current rep. */
  s = 0;
  /** ds/dt of the reference this step (1 = in time with the song). */
  private sRate = 1;
  songOn = false;
  countIn = 0;
  reps = 0;
  repIdx = -1;
  repStart = 0;

  readonly coach = new Autopilot();
  readonly ref: RefSample = makeRefSample();
  private readonly stageBuf = new Float64Array(NM);

  readonly laneMask = new Uint8Array(NM);
  /** Gate per muscle from the rhythm layer: 1 = the player keeps it firing, 0 = its notes were missed. */
  readonly gate = new Float64Array(NM).fill(1);
  private readonly gateS = new Float64Array(NM).fill(1);
  /** Sustained extra excitation (keys held outside the song). */
  readonly hold = new Float64Array(NM);
  private readonly pulseA = new Float64Array(NM);
  /** Coach's activation per muscle (what the lift needs right now). */
  readonly target = new Float64Array(NM);
  readonly excitation = new Float64Array(NM);
  private readonly gain = new Float64Array(NM);
  private readonly free = new Uint8Array(NM);
  private readonly fixedA = new Float64Array(NM);

  tracker = new RepTracker();
  result: RepResult | null = null;
  readonly results: RepResult[] = [];
  message = '';
  phase: PhaseDef | null = null;
  barTrail: [number, number, number][] = [];
  /** Burst pattern for the clean's second pull. */
  static burst = { glutes: 0.85, quads: 0.9, hams: 0.6, core: 0.7, stopHip: 0.2 };
  static brace = true;
  /** Clean: tracking → ballistic burst → pull-under → tracking after the catch. */
  cleanStage: 'track' | 'burst' | 'drop' | 'caught' = 'track';
  private stageT = 0;
  private dropped = false;
  private turnover: { t0: number; sh: number; el: number } | null = null;
  private blend: { q: Float64Array; a: Float64Array; t0: number } | null = null;
  private startQ: Float64Array = new Float64Array(0);
  private readonly startA = new Float64Array(NM);
  private trailTimer = 0;
  private stepCount = 0;
  private readonly pulseDecay: number;
  onEvent: ((type: string, data?: unknown) => void) | null = null;

  constructor(exId: ExerciseId = 'squat') {
    this.world = new LifterWorld(60);
    this.pulseDecay = Math.exp(-this.world.dt / PULSE_TAU);
    this.configure(exId, EXERCISE_MAP[exId].weight.def, 84);
  }

  get repDur(): number {
    return this.plan.repBeats * this.spb;
  }

  /** Length of the glide back to the start pose before a rep that needs a reset. */
  get blendDur(): number {
    return Math.min(0.6, 0.75 * this.spb);
  }

  configure(exId: ExerciseId, weight: number, bpm: number): void {
    this.ex = EXERCISE_MAP[exId];
    this.weight = Math.max(this.ex.weight.min, Math.min(this.ex.weight.max, weight));
    this.bpm = bpm;
    this.spb = 60 / bpm;
    this.world.setBarMass(this.weight);
    this.plan = this.ex.build(this.weight, this.spb);
    this.reset();
  }

  setLanes(ids: MuscleId[]): void {
    this.laneMask.fill(0);
    for (const id of ids) this.laneMask[MI[id]] = 1;
  }

  /** Back to the setup pose, song stopped. */
  reset(): void {
    const p = this.plan;
    this.fk.set(p.startPose);
    this.startQ = this.fk.toSimQ(p.startBar);
    this.world.pinsY = this.ex.pins;
    this.songOn = false;
    this.time = 0;
    this.repIdx = -1;
    this.reps = 0;
    this.results.length = 0;
    this.gate.fill(1);
    this.gateS.fill(1);
    this.hold.fill(0);
    this.pulseA.fill(0);
    this.toStart();
    this.state = 'ready';
    this.result = null;
    this.message = '';
    this.updatePhase();
  }

  /** Teleport to the start pose with the coach's holding activation. */
  private toStart(): void {
    this.world.reset(this.startQ, this.plan.barMode);
    this.s = 0;
    this.cleanStage = 'track';
    this.stageT = 0;
    this.dropped = false;
    this.turnover = null;
    this.blend = null;
    this.barTrail = [];
    this.tracker = new RepTracker();
    this.plan.timeline.sample(0, this.ref);
    const a = this.coach.solveAll(this.world, this.ref);
    this.startA.set(a);
    this.world.muscles.a.set(a);
    this.world.muscles.u.set(a);
    this.primeGrip();
  }

  private primeGrip(): void {
    const g = this.world.barMode === 'hands' ? 0.85 : 0;
    this.world.muscles.a[MI.grip] = g;
    this.world.muscles.u[MI.grip] = g;
  }

  /** Song clock starts at 0; the first rep begins after `countIn` seconds. */
  startSong(countIn: number, reps: number): void {
    this.songOn = true;
    this.time = 0;
    this.countIn = countIn;
    this.reps = reps;
    this.repIdx = -1;
    this.results.length = 0;
  }

  /** A short involuntary twitch of one muscle (stray key press). */
  pulse(i: number, amp: number): void {
    this.pulseA[i] = Math.max(this.pulseA[i], amp);
  }

  /** Step the physics towards song time `t` (catching up over a few frames after a hitch). */
  advanceTo(t: number, maxSteps = 400): void {
    const dt = this.world.dt;
    let n = 0;
    while (this.time + dt * 0.5 < t && n < maxSteps) {
      this.stepOnce();
      n++;
    }
    if (t - this.time > 1.5) this.time = t;
  }

  /** Real-time stepping outside the song (setup pose; keys can be felt). */
  advanceFree(dt: number): void {
    const steps = Math.max(1, Math.round(Math.min(0.05, dt) / this.world.dt));
    for (let k = 0; k < steps; k++) this.stepOnce();
  }

  private stepOnce(): void {
    const w = this.world;
    const dt = w.dt;
    this.time += dt;
    for (let i = 0; i < NM; i++) {
      const g = this.gate[i],
        gs = this.gateS[i];
      this.gateS[i] = gs + (g - gs) * Math.min(1, dt / (g > gs ? GATE_UP : GATE_DOWN));
      this.pulseA[i] *= this.pulseDecay;
    }
    if (this.songOn) this.schedule();
    if (this.state === 'reset') {
      this.stepBlend();
      return;
    }
    this.sRate = 1;
    if (this.repIdx >= 0 && this.state !== 'done' && (this.cleanStage === 'track' || this.cleanStage === 'caught')) {
      const tl = this.plan.timeline;
      const sr = Math.min(this.time - this.repStart, tl.duration);
      if (this.cleanStage === 'track') this.s = sr;
      else {
        // After the catch the reference runs on at 1×; when it is ahead of the song it waits in a
        // hold (single-pose) segment, when behind it catches up at up to 2×.
        const k = tl.segment(this.s);
        const hold = tl.keys[k].pose.every((v, j) => Math.abs(v - tl.keys[k + 1].pose[j]) < 1e-6);
        if (this.s > sr + 0.01) this.sRate = hold ? 0 : 1;
        else if (this.s < sr - 0.01) this.sRate = Math.min(2, 1 + 4 * (sr - this.s));
        this.s = Math.min(tl.duration, this.s + dt * this.sRate);
      }
    }

    this.control();
    const ev = w.step();
    this.stepCount++;

    if (ev.barImpact && ev.barImpact > 0.8) this.onEvent?.('impact', ev.barImpact);
    if (ev.gripFail && this.state === 'lift') this.fail('握力不足，杠铃脱手');
    this.catchCheck();
    this.dropCheck();
    if (this.state === 'lift') this.judge();

    this.trailTimer += dt;
    if (this.trailTimer > 0.02) {
      this.trailTimer = 0;
      const [bx, by] = w.barPos();
      if (this.state === 'lift' || this.state === 'success') {
        this.barTrail.push([bx, by, Math.hypot(...w.barVel())]);
        if (this.barTrail.length > 400) this.barTrail.shift();
      }
    }
    if (this.stepCount % 16 === 0) this.updatePhase();
  }

  // ------------------------------------------------------------------ rep schedule

  private schedule(): void {
    const k = Math.floor((this.time - this.countIn) / this.repDur + 1e-9);
    if (k >= this.reps) {
      if (this.state !== 'done') this.finishSong();
      return;
    }
    if (k >= 0 && k !== this.repIdx) this.beginRep(k);
    if (this.repIdx < 0) return;
    const late = this.time >= this.repStart + this.repDur - this.blendDur;
    if (!late) return;
    if (this.state === 'lift') this.fail('没跟上节奏 — 这一次没能按时完成');
    const last = this.repIdx === this.reps - 1;
    if (!last && this.state !== 'reset' && (this.state === 'fail' || this.plan.resetEachRep)) this.startBlend();
  }

  private beginRep(k: number): void {
    if (this.state === 'reset' || this.state === 'fail') this.toStart();
    this.repIdx = k;
    this.repStart = this.countIn + k * this.repDur;
    this.s = 0;
    this.state = 'lift';
    this.tracker = new RepTracker();
    this.result = null;
    this.message = '';
    this.cleanStage = 'track';
    this.dropped = false;
    this.barTrail = [];
    this.onEvent?.('rep', k);
  }

  private finishSong(): void {
    if (this.state === 'lift') this.fail('没跟上节奏 — 这一次没能按时完成');
    this.state = 'done';
    this.onEvent?.('songEnd');
  }

  private startBlend(): void {
    const q = Float64Array.from(this.world.q);
    const bt = BAR_DOF + 2;
    q[bt] = this.startQ[bt] + Math.atan2(Math.sin(q[bt] - this.startQ[bt]), Math.cos(q[bt] - this.startQ[bt]));
    this.blend = { q, a: Float64Array.from(this.world.muscles.a), t0: this.time };
    this.state = 'reset';
  }

  /** Kinematic glide back to the start pose (the bar is carried back to its start too). */
  private stepBlend(): void {
    const b = this.blend!;
    const u = Math.min(1, (this.time - b.t0) / this.blendDur);
    const k = u * u * (3 - 2 * u);
    const w = this.world;
    for (let i = 0; i < w.q.length; i++) w.q[i] = b.q[i] + (this.startQ[i] - b.q[i]) * k;
    w.qd.fill(0);
    const ms = w.muscles;
    for (let i = 0; i < NM; i++) {
      ms.a[i] = b.a[i] + (this.startA[i] - b.a[i]) * k;
      ms.u[i] = ms.a[i];
      this.target[i] = ms.a[i];
    }
    w.refreshKinematics();
  }

  // ------------------------------------------------------------------ control

  /** Planned COM x of a reference pose (bar weight scaled by the planned load). */
  private plannedCom(ref: RefSample): number {
    const fk = this.fk;
    const w = this.world;
    fk.set(ref.q, w.mb.ox[B.foot], 0);
    let place: 'hands' | 'back' | 'front' = 'hands';
    if (w.barMode === 'back' || w.barMode === 'front') place = w.barMode;
    const load = w.barMode === 'free' ? 0 : ref.load;
    return fk.com(w.barMass * load, fk.rack(place))[0];
  }

  private balanceCorrection(ref: RefSample, gain: number): void {
    const w = this.world;
    const [cx, , cvx] = w.com(true);
    const heelUp = w.mb.th[B.foot] < -0.04;
    const target = heelUp ? w.footEdges()[1] - 0.06 : this.plannedCom(ref);
    const inWindow = !!this.plan.dynamic && this.s > this.plan.dynamic[0] && this.s < this.plan.dynamic[1];
    // Relaxed while the body is ballistic, reinforced while landing the catch.
    const landing = inWindow && this.cleanStage === 'caught';
    const dyn = inWindow && !landing ? 0.6 : landing ? 2 : 1;
    let corr = -(1.3 * (cx - target) + 0.3 * cvx) * gain * dyn;
    const lim = landing ? 0.3 : dyn < 1 ? 0.22 : 0.14;
    corr = Math.max(-lim, Math.min(lim, corr));
    ref.q[JI.ankle] += corr;
    ref.q[JI.hip] += (inWindow ? 0.9 : 0.5) * corr;
  }

  /**
   * Coach solution for every muscle (inverse dynamics + PD + static optimisation). Lane muscles are
   * scaled by their gate; key twitches add on top.
   */
  private control(): void {
    const w = this.world;
    const ms = w.muscles;
    this.plan.timeline.sample(this.repIdx < 0 ? 0 : this.s, this.ref);
    if (this.sRate !== 1) {
      for (let j = 0; j < this.ref.qd.length; j++) {
        this.ref.qd[j] *= this.sRate;
        this.ref.qdd[j] *= this.sRate * this.sRate;
      }
    }
    if (w.barMode === 'free') this.ref.load = 0;
    if ((w.barMode === 'front' || w.barMode === 'back') && this.ex.id === 'clean') this.ref.load = 1;
    const tb = this.turnover;
    if (tb) {
      // The elbows come round the bar into the rack gradually. The real turnover is a 3D rotation
      // about the bar with little inertia; swinging the planar arm there at once would throw the
      // trunk backwards through the shoulder reaction torque.
      const u = Math.min(1, (this.time - tb.t0) / 0.5);
      const k = u * u * (3 - 2 * u);
      for (const [j, from] of [
        [JI.shoulder, tb.sh],
        [JI.elbow, tb.el],
      ]) {
        this.ref.q[j] = from + (this.ref.q[j] - from) * k;
        this.ref.qd[j] = 0;
        this.ref.qdd[j] = 0;
      }
      if (u >= 1) this.turnover = null;
    }
    if (w.barMode === 'front' || w.barMode === 'back') {
      const h = (w.armHold ??= { shoulder: 0, elbow: 0 });
      h.shoulder = this.ref.q[JI.shoulder];
      h.elbow = this.ref.q[JI.elbow];
    }
    this.balanceCorrection(this.ref, 1);
    // Bracing: the abdominals co-contract with the back extensors under load (intra-abdominal pressure);
    // Σa² alone would never co-contract. The optimiser raises the erectors to cancel the flexion torque.
    const loaded = LiftSession.brace && w.barMode !== 'free' && this.ref.load > 0.2;
    this.coach.opt.aMin[MI.core] = loaded ? Math.min(0.4, Math.max(0, 0.5 * ms.a[MI.erectors] - 0.02)) : 0;

    const ballistic = this.ex.id === 'clean' && this.state === 'lift' && this.cleanBallistic();
    const coachA = ballistic ? this.stageBuf : this.coach.solveAll(w, this.ref);
    this.target.set(coachA);

    let weakened = false;
    for (let i = 0; i < NM; i++) {
      const g = this.laneMask[i] ? FLOOR_OF[i] + (1 - FLOOR_OF[i]) * this.gateS[i] : 1;
      this.gain[i] = g;
      if (g < 0.98) weakened = true;
    }
    let a = coachA;
    if (weakened && !ballistic) {
      // Missed muscles stay weak; the automatic ones re-solve around them (synergists compensate
      // where the anatomy allows, balance is kept as well as possible).
      for (let i = 0; i < NM; i++) {
        this.free[i] = this.gain[i] < 0.98 ? 0 : 1;
        this.fixedA[i] = coachA[i] * this.gain[i];
      }
      a = this.coach.opt.solve(ms, this.coach.tauActive, this.free, this.fixedA, this.coach.allJoints);
    }
    for (let i = 0; i < NM; i++) this.excitation[i] = (ballistic ? a[i] * this.gain[i] : a[i]) + this.hold[i] + this.pulseA[i];
    this.excitation[MI.grip] = w.barMode === 'hands' ? 0.85 : 0;
    for (let i = 0; i < NM; i++) ms.u[i] = Math.max(0, Math.min(1, this.excitation[i]));
  }

  /**
   * Clean: from the power position the second pull is ballistic (maximal extensor burst, calves
   * then traps), followed by an active pull-under; tracking resumes after the catch.
   * Returns true while these stages own the coach solution (written to `stageBuf`).
   */
  private cleanBallistic(): boolean {
    const w = this.world;
    const e = this.stageBuf;
    const phaseT = (id: string) => this.plan.phases.find((p) => p.id === id)!.t;
    if (this.cleanStage === 'track') {
      if (this.s < phaseT('second')) return false;
      this.cleanStage = 'burst';
      this.stageT = 0;
    }
    if (this.cleanStage === 'caught') return false;
    this.stageT += w.dt;
    e.fill(0.03);
    if (this.cleanStage === 'burst') {
      const t = this.stageT;
      const Bu = LiftSession.burst;
      e[MI.glutes] = Bu.glutes;
      e[MI.quads] = Bu.quads;
      e[MI.hamstrings] = Bu.hams;
      e[MI.calves] = t > 0.07 ? 0.5 : 0.3;
      e[MI.traps] = t > 0.09 ? 1 : 0.25;
      e[MI.erectors] = 0.8;
      e[MI.core] = Bu.core;
      e[MI.lats] = 0.25;
      e[MI.triceps] = 0.15;
      e[MI.grip] = 0.9;
      if ((w.anat[JI.hip] < Bu.stopHip && w.anat[JI.knee] < 0.25) || t > 0.3) {
        this.cleanStage = 'drop';
        this.stageT = 0;
        this.s = phaseT('under');
      }
      return true;
    }
    // drop: follow the pull-under keyframes with the full tracking controller.
    if (w.barMode === 'front') {
      this.cleanStage = 'caught';
      this.s = Math.max(this.s, phaseT('catch'));
      return false;
    }
    this.s = Math.min(this.s + w.dt, phaseT('recover'));
    this.plan.timeline.sample(this.s, this.ref);
    this.ref.load = Math.min(this.ref.load, 0.5);
    this.balanceCorrection(this.ref, 0.8);
    const a = this.coach.solveAll(w, this.ref);
    for (let i = 0; i < NM; i++) e[i] = a[i];
    e[MI.grip] = 0.9;
    return true;
  }

  private catchCheck(): void {
    const w = this.world;
    if (this.ex.id !== 'clean' || w.barMode !== 'hands' || this.plan.catchFrom === undefined || this.state !== 'lift') return;
    if (this.s < this.plan.catchFrom) return;
    const [rx, ry] = w.point(B.thorax, GEO.rackFront[0], GEO.rackFront[1]);
    const [bx, by] = w.barPos();
    const d = Math.hypot(bx - rx, by - ry);
    const vy = w.qd[12];
    // The 3D elbow turnover around the bar is not representable by the planar arm, so the rack is
    // a guided weld blended in over 0.25 s once the bar is still rising/near its apex and within reach.
    const legsFlexing = w.anat[JI.knee] > 0.25 || w.anatVel[JI.knee] > 0.5;
    if (d < 0.6 && vy > -0.6 && by > 0.8 && legsFlexing) {
      w.rack('front', 0.25);
      this.tracker.racked = true;
      this.turnover = { t0: this.time, sh: w.anat[JI.shoulder], el: w.anat[JI.elbow] };
      this.onEvent?.('rack');
    }
  }

  /** Clean: after the lockout the bar is pushed forward off the shoulders onto the platform. */
  private dropCheck(): void {
    const p = this.plan;
    const w = this.world;
    if (p.dropAt === undefined || this.dropped || this.s < p.dropAt || w.barMode !== 'front' || this.state === 'lift') return;
    this.dropped = true;
    w.release();
    w.qd[BAR_DOF] += 0.8;
    this.onEvent?.('drop');
  }

  // ------------------------------------------------------------------ judging

  private fail(reason: string): void {
    if (this.state !== 'lift') return;
    this.state = 'fail';
    this.result = { rep: this.repIdx, ok: false, reason, form: 0, details: [], peakPower: this.tracker.peakPower, time: this.tracker.t, bonus: 0 };
    this.results.push(this.result);
    this.message = reason;
    this.onEvent?.('fail', reason);
  }

  private succeed(): void {
    if (this.state !== 'lift') return;
    const tr = this.tracker;
    const details: string[] = [];
    let form = 100;
    const lumbarDeg = (tr.maxLumbar * 180) / Math.PI;
    if (lumbarDeg > 18) {
      form -= Math.min(40, (lumbarDeg - 18) * 2.5);
      details.push(`腰椎最大屈曲 ${lumbarDeg.toFixed(0)}°（弓腰）`);
    }
    if (tr.copEdgeTime > 0.15) {
      form -= Math.min(25, tr.copEdgeTime * 20);
      details.push(`重心偏离足中 ${tr.copEdgeTime.toFixed(1)}s`);
    }
    if (tr.barDevN > 0) {
      const dev = Math.sqrt(tr.barDevSum / tr.barDevN) * 100;
      if (dev > 4.5) {
        form -= Math.min(20, (dev - 4.5) * 3);
        details.push(`杠铃轨迹偏离 ${dev.toFixed(1)}cm`);
      }
    }
    if (tr.hipsFirst > 0.25) {
      form -= Math.min(15, tr.hipsFirst * 20);
      details.push('起身时臀部先起（膝髋不同步）');
    }
    form = Math.max(0, Math.round(form));
    if (!details.length) details.push('动作标准！');
    this.state = 'success';
    this.result = { rep: this.repIdx, ok: true, reason: '成功', form, details, peakPower: tr.peakPower, time: tr.t, bonus: Math.round(this.weight * 20 * (form / 100)) };
    this.results.push(this.result);
    this.message = `成功！动作评分 ${form}`;
    this.onEvent?.('success', this.result);
  }

  private judge(): void {
    const w = this.world;
    const tr = this.tracker;
    const dt = w.dt;
    tr.t += dt;
    const anat = w.anat;
    const hip = anat[JI.hip],
      knee = anat[JI.knee];
    const [bx, by] = w.barPos();
    const [, bvy] = w.barVel();
    tr.maxBarY = Math.max(tr.maxBarY, by);

    tr.maxLumbar = Math.max(tr.maxLumbar, anat[JI.lumbar]);
    if (anat[JI.lumbar] > 40 * (Math.PI / 180)) return this.fail('腰椎过度屈曲 — 受伤风险！');

    const [heelX, toeX] = w.footEdges();
    const [cx] = w.com(true);
    const footTh = w.mb.th[B.foot];
    const span = toeX - heelX;
    if (w.grfY > 50) {
      const rel = (w.copX - heelX) / span;
      if (rel < 0.08 || rel > 0.92) tr.copEdgeTime += dt;
    }
    const dynWin = this.plan.dynamic;
    const explosive = !!dynWin && this.s > dynWin[0] && this.s < dynWin[1] + 0.15;
    const backLim = explosive ? 0.45 : 0.22;
    const comMargin = explosive ? 0.16 : 0.08;
    if (footTh > backLim || cx < heelX - comMargin) return this.fail('重心过于靠后 — 向后失去平衡');
    if ((!explosive && footTh < -0.4) || footTh < -0.7 || cx > toeX + comMargin + 0.02) return this.fail('重心过于靠前 — 向前失去平衡');
    if (w.bodyFloorF > 60) return this.fail('摔倒了');
    if (footTh < -0.05) tr.heelRaise = Math.max(tr.heelRaise, -footTh);

    if (w.barSupported()) tr.peakPower = Math.max(tr.peakPower, w.barMass * 9.81 * bvy);

    const id = this.ex.id;
    const phaseT = (pid: string) => this.plan.phases.find((p) => p.id === pid)!.t;
    const standing = hip < 15 * (Math.PI / 180) && knee < 15 * (Math.PI / 180) && Math.abs(w.anatVel[JI.hip]) < 0.4 && Math.abs(w.anatVel[JI.knee]) < 0.4;

    if (id === 'squat' || id === 'frontSquat') {
      const thighDeg = (Math.atan2(w.q[1] - w.mb.oy[B.shank], Math.abs(w.mb.ox[B.shank] - w.q[0])) * 180) / Math.PI;
      const depth = 6 - thighDeg;
      tr.maxDepth = Math.max(tr.maxDepth, depth);
      if (depth > 0) tr.reachedDepth = true;
      if (tr.reachedDepth && w.anatVel[JI.knee] < -0.2) {
        const r = -w.anatVel[JI.hip] / Math.max(0.05, -w.anatVel[JI.knee]);
        if (r < 0.35 && knee > 0.8) tr.hipsFirst += dt;
      }
      if (w.pinF > 30) {
        tr.pinTime += dt;
        if (tr.pinTime > 0.35) return this.fail('没站起来 — 杠铃落在保护杠上');
      }
      if (tr.reachedDepth && standing) return this.succeed();
      if (!tr.reachedDepth && this.s > phaseT('ascent') + this.spb) return this.fail('深度不够 — 大腿没有低于水平');
    } else if (id === 'deadlift') {
      if (!tr.liftOff && w.barFloorF < 1 && by > w.plateR + 0.015) tr.liftOff = true;
      if (tr.liftOff) {
        tr.barDevSum += (bx - GEO.midfoot) ** 2;
        tr.barDevN++;
      }
      if (!tr.liftOff && this.s > phaseT('knee') + 0.5 * this.spb) return this.fail('拉不动 — 杠铃没有离地');
      if (tr.liftOff && w.barFloorF > 50 && by < w.plateR + 0.01 && tr.maxBarY > 0.4) return this.fail('杠铃掉回地面');
      if (tr.liftOff && by > 0.7 && standing) return this.succeed();
    } else if (id === 'rdl') {
      if (by < 0.5) tr.reachedDepth = true;
      tr.barDevSum += (bx - GEO.midfoot) ** 2;
      tr.barDevN++;
      if (tr.reachedDepth && standing && by > 0.7) return this.succeed();
      if (w.barFloorF > 50) return this.fail('杠铃掉到地面');
    } else if (id === 'clean') {
      if (!tr.liftOff && w.barFloorF < 1 && by > w.plateR + 0.015) tr.liftOff = true;
      if (tr.liftOff && !tr.racked) {
        tr.barDevSum += (bx - GEO.midfoot) ** 2;
        tr.barDevN++;
      }
      if (!tr.liftOff && this.s > phaseT('scoop')) return this.fail('拉不动 — 杠铃没有离地');
      if (tr.liftOff && !tr.racked && w.barFloorF > 50 && tr.maxBarY > 0.45) return this.fail('没接住 — 杠铃掉回地面');
      if (tr.liftOff && !tr.racked && this.s > phaseT('recover') + this.spb) return this.fail('没能翻上肩');
      if (tr.racked && standing && w.barMode === 'front') return this.succeed();
    }
  }

  private updatePhase(): void {
    const phases = this.plan.phases;
    let cur = phases[0];
    const s = this.repIdx < 0 ? 0 : this.s;
    for (const p of phases) if (s >= p.t) cur = p;
    this.phase = cur;
  }
}
