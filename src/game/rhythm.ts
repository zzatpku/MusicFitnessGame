import type { Chart, Note } from './chart.ts';

export type Judgement = 'perfect' | 'great' | 'good' | 'miss';
/** Timing windows (s, ±). */
export const WINDOW = { perfect: 0.045, great: 0.09, good: 0.135 };
const WEIGHT: Record<Judgement, number> = { perfect: 1, great: 0.8, good: 0.5, miss: 0 };
/** How strongly a hit keeps its muscle firing (sloppy timing = slightly weaker contraction). */
const GATE_OF: Record<Judgement, number> = { perfect: 1, great: 0.97, good: 0.9, miss: 0.9 };
/** Releasing a hold this close to its tail still completes it. */
const HOLD_EARLY = 0.12;

export interface NoteState {
  note: Note;
  judged: Judgement | null;
  offset: number;
  holding: boolean;
  tail: Judgement | null;
  missAt: number;
}

/**
 * Judges key presses against the chart and turns the result into per-lane gates for the physics:
 * a hit switches the lane's muscle on, a miss (or a hold let go early) switches it off until the
 * next hit in that lane.
 */
export class RhythmGame {
  readonly chart: Chart;
  readonly states: NoteState[];
  private readonly lanes: NoteState[][];
  private readonly nextIdx: number[];
  private readonly activeHold: (NoteState | null)[];
  private readonly gate: number[];
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
    this.gate = new Array(n).fill(1);
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
    if (this.autoplay) return 'stray';
    const L = this.lanes[lane];
    const h = this.activeHold[lane];
    if (h && !h.holding && t < h.note.end - HOLD_EARLY) {
      h.holding = true;
      this.gate[lane] = GATE_OF[h.judged ?? 'good'];
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
    return 'stray';
  }

  release(lane: number, t: number): void {
    this.down[lane] = false;
    if (this.autoplay) return;
    const h = this.activeHold[lane];
    if (!h || !h.holding) return;
    h.holding = false;
    if (t >= h.note.end - HOLD_EARLY) this.finishHold(lane, h, 'perfect', t);
    else this.gate[lane] = 0;
  }

  /** Advance the song clock: autoplay hits, misses for notes that left their window, hold tails. */
  update(t: number): void {
    for (let lane = 0; lane < this.lanes.length; lane++) {
      const L = this.lanes[lane];
      if (this.autoplay) {
        while (this.nextIdx[lane] < L.length && L[this.nextIdx[lane]].note.t <= t) {
          const s = L[this.nextIdx[lane]++];
          s.judged = 'perfect';
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
    h.holding = false;
    h.tail = j;
    if (j === 'miss') h.missAt = t;
    this.activeHold[lane] = null;
    this.register(lane, j, 0, true);
  }

  /** 0..1: how much the lane's muscle is allowed to fire right now. */
  gateAt(lane: number): number {
    return this.gate[lane];
  }

  isHolding(lane: number): boolean {
    return !!this.activeHold[lane]?.holding;
  }

  private register(lane: number, j: Judgement, offset: number, tail: boolean): void {
    this.judgedUnits++;
    this.accSum += WEIGHT[j];
    this.counts[j]++;
    if (!tail || j === 'miss') this.gate[lane] = GATE_OF[j] * (j === 'miss' ? 0 : 1);
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
