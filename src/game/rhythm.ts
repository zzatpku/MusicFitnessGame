import type { Chart, Note } from './chart.ts';

export type Judgement = 'perfect' | 'great' | 'good' | 'miss';
/** Timing windows (s, ±). */
export const WINDOW = { perfect: 0.045, great: 0.09, good: 0.135 };
const WEIGHT: Record<Judgement, number> = { perfect: 1, great: 0.8, good: 0.5, miss: 0 };
/** Releasing a hold this close to its tail still completes it. */
const HOLD_EARLY = 0.12;

/**
 * Rate coding: every press is a burst of neural drive (rise ~30 ms, fade ~0.4 s). The same kernel
 * over the chart's notes gives the drive the lift expects, so pressing as densely as the notes
 * yields exactly the coach's activation.
 */
const RISE = 0.03;
const FADE = 0.4;
const burst = (s: number) => (s < 0 ? 0 : (1 - Math.exp(-s / RISE)) * Math.exp(-s / FADE));
/** Extra activation per unit of drive beyond what the notes ask for (mashing piles up). */
const EXCESS_GAIN = 0.25;
/** A key held down outside a hold note becomes a sustained hard contraction after this long. */
const HOLD_AFTER = 0.3;
const HOLD_EXCESS = 0.6;

export interface Drive {
  /** Share of the needed activation the presses deliver (0..1). */
  ratio: number;
  /** Activation on top of what the lift needs (extra presses, keys held down). */
  excess: number;
}

export interface NoteState {
  note: Note;
  judged: Judgement | null;
  offset: number;
  holding: boolean;
  tail: Judgement | null;
  missAt: number;
}

/**
 * Judges key presses against the chart (score, combo) and turns the presses themselves into neural
 * drive for the physics: each press is a contraction of that lane's muscle.
 */
export class RhythmGame {
  readonly chart: Chart;
  readonly states: NoteState[];
  private readonly lanes: NoteState[][];
  private readonly nextIdx: number[];
  private readonly activeHold: (NoteState | null)[];
  private readonly presses: number[][];
  private readonly strays: number[][];
  private readonly downSince: number[];
  readonly down: boolean[];
  combo = 0;
  maxCombo = 0;
  score = 0;
  stray = 0;
  readonly counts: Record<Judgement, number> = { perfect: 0, great: 0, good: 0, miss: 0 };
  readonly laneHit: number[];
  readonly laneMiss: number[];
  readonly total: number;
  judgedUnits = 0;
  private accSum = 0;
  autoplay = false;
  onJudge: ((lane: number, j: Judgement, offset: number, tail: boolean) => void) | null = null;

  constructor(chart: Chart) {
    this.chart = chart;
    const n = chart.lanes.length;
    this.states = chart.notes.map((note) => ({ note, judged: null, offset: 0, holding: false, tail: null, missAt: 0 }));
    this.lanes = Array.from({ length: n }, () => []);
    for (const s of this.states) this.lanes[s.note.lane].push(s);
    for (const L of this.lanes) L.sort((a, b) => a.note.t - b.note.t);
    this.nextIdx = new Array(n).fill(0);
    this.activeHold = new Array(n).fill(null);
    this.presses = Array.from({ length: n }, () => []);
    this.strays = Array.from({ length: n }, () => []);
    this.downSince = new Array(n).fill(NaN);
    this.down = new Array(n).fill(false);
    this.laneHit = new Array(n).fill(0);
    this.laneMiss = new Array(n).fill(0);
    this.total = chart.notes.reduce((s, nt) => s + (nt.hold ? 2 : 1), 0);
  }

  /** Accuracy over the notes judged so far (0..1). */
  get accuracy(): number {
    return this.judgedUnits ? this.accSum / this.judgedUnits : 1;
  }

  /** Accuracy over the whole chart (unplayed notes count as misses). */
  get finalAccuracy(): number {
    return this.total ? this.accSum / this.total : 1;
  }

  press(lane: number, t: number): Judgement | 'stray' | 'regrab' {
    this.down[lane] = true;
    this.downSince[lane] = t;
    this.logPress(lane, t);
    if (this.autoplay) return 'stray';
    const L = this.lanes[lane];
    const h = this.activeHold[lane];
    if (h && !h.holding && t < h.note.end - HOLD_EARLY) {
      h.holding = true;
      return 'regrab';
    }
    const s = L[this.nextIdx[lane]];
    if (s && Math.abs(t - s.note.t) <= WINDOW.good) {
      const d = t - s.note.t;
      const ad = Math.abs(d);
      const j: Judgement = ad <= WINDOW.perfect ? 'perfect' : ad <= WINDOW.great ? 'great' : 'good';
      s.judged = j;
      s.offset = d;
      this.nextIdx[lane]++;
      if (s.note.hold) {
        s.holding = true;
        this.activeHold[lane] = s;
      }
      this.register(lane, j, d, false);
      return j;
    }
    this.stray++;
    this.strays[lane].push(t);
    if (this.strays[lane].length > 64) this.strays[lane].shift();
    return 'stray';
  }

  release(lane: number, t: number): void {
    this.down[lane] = false;
    this.downSince[lane] = NaN;
    if (this.autoplay) return;
    const h = this.activeHold[lane];
    if (!h || !h.holding) return;
    h.holding = false;
    if (t >= h.note.end - HOLD_EARLY) this.finishHold(lane, h, 'perfect', t);
  }

  private logPress(lane: number, t: number): void {
    const P = this.presses[lane];
    P.push(t);
    while (P.length && P[0] < t - 3) P.shift();
  }

  /** Presses in `lane` that matched no note since song time `since`. */
  straysSince(lane: number, since: number): number {
    return this.strays[lane].filter((s) => s >= since).length;
  }

  /** The lane's key is being held down outside a hold note long enough to count as clenching. */
  clenching(lane: number, t: number): boolean {
    const h = this.activeHold[lane];
    return !(h && t < h.note.end) && t - this.downSince[lane] > HOLD_AFTER;
  }

  /** Advance the song clock: autoplay hits, misses for notes that left their window, hold tails. */
  update(t: number): void {
    for (let lane = 0; lane < this.lanes.length; lane++) {
      const L = this.lanes[lane];
      if (this.autoplay) {
        while (this.nextIdx[lane] < L.length && L[this.nextIdx[lane]].note.t <= t) {
          const s = L[this.nextIdx[lane]++];
          s.judged = 'perfect';
          this.logPress(lane, s.note.t);
          this.register(lane, 'perfect', 0, false);
          if (s.note.hold) {
            s.holding = true;
            this.activeHold[lane] = s;
          }
        }
      }
      while (this.nextIdx[lane] < L.length && t > L[this.nextIdx[lane]].note.t + WINDOW.good) {
        const s = L[this.nextIdx[lane]++];
        s.judged = 'miss';
        s.missAt = s.note.t + WINDOW.good;
        this.register(lane, 'miss', 0, false);
        if (s.note.hold) this.activeHold[lane] = s;
      }
      const h = this.activeHold[lane];
      if (h && t >= h.note.end) this.finishHold(lane, h, h.holding ? 'perfect' : 'miss', h.note.end);
    }
  }

  private finishHold(lane: number, h: NoteState, j: Judgement, t: number): void {
    // Keeping the key down past a completed hold only starts to count as clenching from here.
    if (h.holding && this.down[lane]) this.downSince[lane] = h.note.end;
    h.holding = false;
    h.tail = j;
    if (j === 'miss') h.missAt = t;
    this.activeHold[lane] = null;
    this.register(lane, j, 0, true);
  }

  /**
   * Neural drive of a lane's muscle at song time `t`, from the presses themselves. Presses as dense
   * as the notes → ratio 1; fewer → proportionally weaker; more (or a key held down outside a hold
   * note) → excess activation on top of what the lift needs.
   */
  driveAt(lane: number, t: number): Drive {
    const h = this.activeHold[lane];
    if (h && t < h.note.end) return { ratio: h.holding ? 1 : 0, excess: 0 };
    let expected = 0;
    for (const st of this.lanes[lane]) {
      const s = st.note.t;
      if (s > t) break;
      if (s > t - 2.5) expected += burst(t - s);
    }
    let delivered = 0;
    for (const p of this.presses[lane]) if (p <= t) delivered += burst(t - p);
    const ratio = expected > 0.05 ? Math.min(1, delivered / expected) : 1;
    let excess = Math.max(0, delivered - expected) * EXCESS_GAIN;
    const held = t - this.downSince[lane];
    if (held > HOLD_AFTER) excess += HOLD_EXCESS * Math.min(1, (held - HOLD_AFTER) / HOLD_AFTER);
    return { ratio, excess };
  }

  isHolding(lane: number): boolean {
    return !!this.activeHold[lane]?.holding;
  }

  private register(lane: number, j: Judgement, offset: number, tail: boolean): void {
    this.judgedUnits++;
    this.accSum += WEIGHT[j];
    this.counts[j]++;
    if (j === 'miss') {
      this.combo = 0;
      this.laneMiss[lane]++;
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.laneHit[lane]++;
      this.score += Math.round(1000 * WEIGHT[j] * (1 + Math.min(this.combo, 50) / 100));
    }
    this.onJudge?.(lane, j, offset, tail);
  }
}

export function grade(acc: number, repsOk: number, reps: number): string {
  const lift = reps ? repsOk / reps : 1;
  const v = acc * 0.7 + lift * 0.3;
  return v >= 0.95 ? 'S' : v >= 0.88 ? 'A' : v >= 0.78 ? 'B' : v >= 0.65 ? 'C' : 'D';
}
