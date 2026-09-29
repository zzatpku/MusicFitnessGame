import { MUSCLES, NM, type MuscleId } from '../sim/muscles.ts';
import { EXERCISE_MAP, type Difficulty, type ExerciseId } from './exercises.ts';
import type { LiftSession } from './session.ts';
import { buildChart, type Chart, type Recording } from './chart.ts';

export const LANE_COUNT: Record<Difficulty, number> = { easy: 4, normal: 6, hard: 8, expert: 9 };
export const TEMPOS = [
  { bpm: 70, cn: '慢' },
  { bpm: 84, cn: '中' },
  { bpm: 100, cn: '快' },
];
export const REP_OPTIONS = [3, 5, 8];
export const COUNT_IN_BEATS = 4;
export const OUTRO_BEATS = 4;

/** Lanes run left → right from the feet up: legs under the left hand, trunk and arms under the right. */
const BODY_ORDER: MuscleId[] = ['calves', 'tibialis', 'quads', 'hamstrings', 'glutes', 'iliopsoas', 'core', 'erectors', 'lats', 'traps', 'delts', 'biceps', 'triceps', 'grip'];

export function laneMuscles(ex: ExerciseId, diff: Difficulty): MuscleId[] {
  const pick = EXERCISE_MAP[ex].lanes.slice(0, LANE_COUNT[diff]);
  return BODY_ORDER.filter((id) => pick.includes(id));
}

export interface SongConfig {
  ex: ExerciseId;
  weight: number;
  bpm: number;
  diff: Difficulty;
  reps: number;
}

export interface Song {
  cfg: SongConfig;
  lanes: MuscleId[];
  chart: Chart;
  recording: Recording;
}

/** Run one rep with every muscle on the coach and record what each muscle had to do. */
export function recordCoach(s: LiftSession): Recording {
  const onEvent = s.onEvent;
  s.onEvent = null;
  s.setLanes([]);
  s.reset();
  s.startSong(0, 1);
  const dt = 0.01;
  const n = Math.round(s.repDur / dt);
  const act = MUSCLES.map(() => new Float32Array(n));
  for (let k = 0; k < n; k++) {
    s.advanceTo((k + 1) * dt);
    for (let i = 0; i < NM; i++) act[i][k] = s.target[i];
  }
  const plan = s.plan;
  const second = plan.phases.find((p) => p.id === 'second');
  const recover = plan.phases.find((p) => p.id === 'recover');
  const rec: Recording = {
    dt,
    act,
    duration: s.repDur,
    ok: s.results[0]?.ok ?? false,
    explosive: second && recover ? [second.t - 0.01, recover.t] : null,
    phases: plan.phases.filter((p) => p.id !== 'setup').map((p) => ({ t: p.t, cn: p.cn })),
  };
  s.reset();
  s.onEvent = onEvent;
  return rec;
}

/** Configure the session for the song, record the coach and write the chart. */
export function buildSong(cfg: SongConfig, s: LiftSession): Song {
  s.configure(cfg.ex, cfg.weight, cfg.bpm);
  cfg.weight = s.weight;
  const recording = recordCoach(s);
  const lanes = laneMuscles(cfg.ex, cfg.diff);
  const chart = buildChart(recording, lanes, {
    bpm: cfg.bpm,
    spb: s.spb,
    countIn: COUNT_IN_BEATS * s.spb,
    repDur: s.repDur,
    reps: cfg.reps,
    outro: OUTRO_BEATS * s.spb,
    diff: cfg.diff,
  });
  s.setLanes(lanes);
  return { cfg, lanes, chart, recording };
}
