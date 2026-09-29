import { MI, type MuscleId } from '../sim/muscles.ts';
import type { Difficulty } from './exercises.ts';

/** One falling note: "this muscle, fire (a bit more) now". */
export interface Note {
  lane: number;
  /** Song time of the head (s). */
  t: number;
  /** Song time of the tail (== t for taps). */
  end: number;
  hold: boolean;
  /** Coach activation this note stands for (0..1). */
  strength: number;
  rep: number;
}

export interface PhaseMark {
  t: number;
  label: string;
}

export interface Chart {
  lanes: MuscleId[];
  notes: Note[];
  phases: PhaseMark[];
  bpm: number;
  spb: number;
  countIn: number;
  repDur: number;
  reps: number;
  duration: number;
}

/** Coach activations of one demo rep (sampled every `dt`), the source of the chart. */
export interface Recording {
  dt: number;
  act: Float32Array[];
  duration: number;
  ok: boolean;
  /** Rep-relative window where 16th notes are allowed (ballistic part of the clean). */
  explosive: [number, number] | null;
  phases: { t: number; cn: string }[];
}

/**
 * Playability caps: keys per hand at one instant (a two-finger chord is easy — both leg extensors
 * firing together), distinct rhythmic events per beat, simultaneous holds, and whether 16ths are allowed.
 */
const LIMITS: Record<Difficulty, { perHand: number; events: number; holds: number; sixteenths: boolean; high: number }> = {
  easy: { perHand: 2, events: 2, holds: 1, sixteenths: false, high: 0.5 },
  normal: { perHand: 2, events: 3, holds: 2, sixteenths: true, high: 0.3 },
  expert: { perHand: 2, events: 4, holds: 2, sixteenths: true, high: 0.3 },
};
/** Activation at which a muscle gets notes, and below which an episode of activity ends. */
const ON = 0.12;
const OFF = 0.07;

interface Cand {
  lane: number;
  cell: number;
  endCell: number;
  hold: boolean;
  strength: number;
  onset: boolean;
}

/**
 * Turn the coach's activation profile into notes on a 16th grid. Denser notes = harder effort:
 * above the difficulty's `high` activation → 8th notes, from 0.12 → one per beat; steady moderate
 * bracing of 2–4 beats becomes a hold. Chords and density are capped per difficulty.
 */
export function buildChart(
  rec: Recording,
  lanes: MuscleId[],
  o: { bpm: number; spb: number; countIn: number; repDur: number; reps: number; outro: number; diff: Difficulty },
): Chart {
  const q = o.spb / 4;
  const nCells = Math.round(o.repDur / q);
  const lim = LIMITS[o.diff];
  const explosive = (c: number) => lim.sixteenths && !!rec.explosive && c * q >= rec.explosive[0] - 1e-6 && c * q < rec.explosive[1];
  const cands: Cand[] = [];

  lanes.forEach((id, lane) => {
    const a = rec.act[MI[id]];
    const mean = new Float64Array(nCells + 1);
    const peak = new Float64Array(nCells + 1);
    for (let c = 0; c < nCells; c++) {
      const k0 = Math.floor((c * q) / rec.dt);
      const k1 = Math.max(k0 + 1, Math.floor(((c + 1) * q) / rec.dt));
      let s = 0,
        p = 0,
        n = 0;
      for (let k = k0; k < k1 && k < a.length; k++, n++) {
        s += a[k];
        p = Math.max(p, a[k]);
      }
      mean[c] = n ? s / n : 0;
      peak[c] = p;
    }
    const episodes: [number, number][] = [];
    let start = -1;
    for (let c = 0; c < nCells; c++) {
      if (start < 0 && peak[c] >= ON) start = c;
      else if (start >= 0 && mean[c] < OFF) {
        episodes.push([start, c]);
        start = -1;
      }
    }
    if (start >= 0) episodes.push([start, nCells]);
    const merged: [number, number][] = [];
    for (const e of episodes) {
      const last = merged[merged.length - 1];
      if (last && e[0] - last[1] < 4) last[1] = e[1];
      else merged.push([e[0], e[1]]);
    }

    for (const [c0, c1] of merged) {
      let sum = 0,
        sum2 = 0,
        pk = 0;
      for (let c = c0; c < c1; c++) {
        sum += mean[c];
        sum2 += mean[c] * mean[c];
        pk = Math.max(pk, peak[c]);
      }
      const n = c1 - c0;
      const avg = sum / n;
      const sd = Math.sqrt(Math.max(0, sum2 / n - avg * avg));
      const startCell = explosive(c0) ? c0 : c0 - (c0 % 2);
      if (n >= 8 && n <= 16 && sd < 0.3 * avg && pk < 0.6 && !explosive(c0)) {
        const endCell = Math.min(nCells, c1 + (c1 % 2));
        cands.push({ lane, cell: startCell, endCell, hold: true, strength: avg, onset: true });
        continue;
      }
      let last = -99;
      for (let c = startCell; c < c1; c++) {
        const m = 0.5 * (mean[c] + mean[c + 1]);
        const gap = c - last;
        const onset = c === startCell;
        let place = onset;
        if (!place && explosive(c)) {
          const rise = mean[c] - mean[Math.max(0, c - 2)];
          place = (m >= lim.high && c % 2 === 0 && gap >= 2) || (mean[c] >= lim.high && rise > 0.2 && gap >= 1);
        } else if (!place) {
          place = m >= lim.high ? c % 2 === 0 && gap >= 2 : m >= ON && c % 4 === 0 && gap >= 4;
        }
        if (!place) continue;
        cands.push({ lane, cell: c, endCell: c, hold: false, strength: Math.max(m, mean[c]), onset });
        last = c;
      }
    }
  });

  // Too many simultaneous holds: the weakest becomes beat taps.
  cands.sort((x, y) => x.cell - y.cell);
  const holds = cands.filter((c) => c.hold);
  for (const h of holds) {
    const overlapping = holds.filter((o2) => o2 !== h && o2.hold && o2.cell < h.endCell && h.cell < o2.endCell);
    if (overlapping.length < lim.holds) continue;
    const weakest = [h, ...overlapping].sort((x, y) => x.strength - y.strength)[0];
    weakest.hold = false;
    for (let c = weakest.cell + 4 - (weakest.cell % 4); c < weakest.endCell; c += 4)
      cands.push({ lane: weakest.lane, cell: c, endCell: c, hold: false, strength: weakest.strength, onset: false });
    weakest.endCell = weakest.cell;
  }

  // Per-hand chord cap at each instant (keep the strongest notes, prefer onsets).
  const rank = (c: Cand) => c.strength + (c.onset ? 0.5 : 0) + (c.hold ? 0.3 : 0);
  const split = Math.ceil(lanes.length / 2);
  const kept = new Set<Cand>(cands);
  const byCell = new Map<number, Cand[]>();
  for (const c of cands) (byCell.get(c.cell) ?? byCell.set(c.cell, []).get(c.cell)!).push(c);
  for (const group of byCell.values()) {
    for (const hand of [0, 1]) {
      const mine = group.filter((c) => (c.lane < split ? 0 : 1) === hand).sort((x, y) => rank(y) - rank(x));
      for (const c of mine.slice(lim.perHand)) kept.delete(c);
    }
  }
  // Rhythmic density: at most `events` distinct instants per beat; the weakest instants go.
  for (let b = 0; b * 4 < nCells; b++) {
    const cells = new Map<number, number>();
    for (const c of kept) if (c.cell >= b * 4 && c.cell < b * 4 + 4) cells.set(c.cell, Math.max(cells.get(c.cell) ?? 0, rank(c)));
    if (cells.size <= lim.events) continue;
    const drop = [...cells.entries()].sort((x, y) => x[1] - y[1]).slice(0, cells.size - lim.events).map(([cell]) => cell);
    for (const c of [...kept]) if (drop.includes(c.cell) && !c.hold) kept.delete(c);
  }
  // A lane cannot have taps while its own key is held down.
  for (const h of [...kept].filter((c) => c.hold))
    for (const c of kept) if (c !== h && c.lane === h.lane && c.cell >= h.cell && c.cell <= h.endCell) kept.delete(c);

  const pattern = [...kept].sort((x, y) => x.cell - y.cell || x.lane - y.lane);
  const notes: Note[] = [];
  const phases: PhaseMark[] = [];
  for (let r = 0; r < o.reps; r++) {
    const t0 = o.countIn + r * o.repDur;
    for (const c of pattern) notes.push({ lane: c.lane, t: t0 + c.cell * q, end: t0 + c.endCell * q, hold: c.hold, strength: Math.min(1, c.strength), rep: r });
    for (const p of rec.phases) phases.push({ t: t0 + p.t, label: p.cn });
  }
  return {
    lanes,
    notes,
    phases,
    bpm: o.bpm,
    spb: o.spb,
    countIn: o.countIn,
    repDur: o.repDur,
    reps: o.reps,
    duration: o.countIn + o.reps * o.repDur + o.outro,
  };
}
