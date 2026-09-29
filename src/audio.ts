import type { Section } from './game/exercises.ts';
import type { Judgement } from './game/rhythm.ts';

/** Shared WebAudio graph: music, note hits and effects on separate buses into a gentle limiter. */
export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  music!: GainNode;
  duck!: GainNode;
  hits!: GainNode;
  sfx!: GainNode;
  noise!: AudioBuffer;
  private clockOff = 0;
  private clockInit = false;

  /** Create (or resume) the context; call from a user gesture. */
  ensure(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ latencyHint: 'interactive' });
      } catch {
        return null;
      }
      const ctx = this.ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      this.master = ctx.createGain();
      this.master.gain.value = 0.85;
      this.master.connect(comp).connect(ctx.destination);
      this.music = ctx.createGain();
      this.music.gain.value = 0.55;
      this.duck = ctx.createGain();
      this.duck.connect(this.music).connect(this.master);
      this.hits = ctx.createGain();
      this.hits.gain.value = 0.42;
      this.hits.connect(this.master);
      this.sfx = ctx.createGain();
      this.sfx.gain.value = 0.7;
      this.sfx.connect(this.master);
      const n = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  suspend(): void {
    if (this.ctx?.state === 'running') void this.ctx.suspend();
    this.clockInit = false;
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
    this.clockInit = false;
  }

  /**
   * Context time reaching the speakers at `perfMs` (performance.now() clock): the audio clock
   * (which advances in render quanta) smoothed against the performance clock, minus output latency.
   * Frozen while the context is suspended.
   */
  heardTime(perfMs = performance.now()): number {
    const ctx = this.ctx;
    if (!ctx) return perfMs / 1000;
    const lat = ctx.outputLatency || ctx.baseLatency || 0;
    if (ctx.state !== 'running') {
      this.clockInit = false;
      return ctx.currentTime - lat;
    }
    const off = ctx.currentTime - performance.now() / 1000;
    if (!this.clockInit || Math.abs(off - this.clockOff) > 0.05) {
      this.clockOff = off;
      this.clockInit = true;
    } else this.clockOff += (off - this.clockOff) * 0.02;
    return perfMs / 1000 + this.clockOff - lat;
  }

  noiseSrc(t: number, dur: number): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 1.5, dur + 0.05);
    return src;
  }
}

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export interface Arrangement {
  bpm: number;
  countInBeats: number;
  repBeats: number;
  reps: number;
  outroBeats: number;
  sections: Section[];
  /** Root of the key (MIDI) and a chord per bar as semitone offsets of the chord root. */
  root: number;
  progression: number[];
  /** Rep-relative beats that get an impact (the effort peak). */
  accents: number[];
}

/** Minor chord roots (semitones from the key root) per exercise, one chord per bar. */
export const PROGRESSIONS: Record<string, { root: number; prog: number[] }> = {
  squat: { root: 45, prog: [0, 8, 3, 10] },
  frontSquat: { root: 40, prog: [0, 5, 8, 7] },
  deadlift: { root: 38, prog: [0, 10, 8, 10] },
  rdl: { root: 36, prog: [0, 8, 5, 7] },
  clean: { root: 43, prog: [0, 8, 10] },
};

/** Minor-key triad quality for a chord root offset (i, iv, v minor; III, VI, VII major). */
const chordTones = (off: number): number[] => {
  const major = off === 3 || off === 8 || off === 10;
  return [0, major ? 4 : 3, 7];
};

const PENTA = [0, 3, 5, 7, 10];

/**
 * Procedural workout track that follows the lift: each rep is 2–3 bars whose sections (build-up,
 * full groove, cool-down) line up with the phases of the movement. A look-ahead scheduler places
 * every event on the audio clock.
 */
export class Music {
  private readonly e: AudioEngine;
  private arr: Arrangement | null = null;
  private startCtx = 0;
  private nextStep = 0;
  private timer: number | null = null;
  private holdVoices = new Map<number, { osc: OscillatorNode; g: GainNode }>();

  constructor(e: AudioEngine) {
    this.e = e;
  }

  get playing(): boolean {
    return this.arr !== null;
  }

  /** Start the song so that song time 0 plays at context time `startCtx`. */
  start(arr: Arrangement, startCtx: number): void {
    this.stop();
    this.arr = arr;
    this.startCtx = startCtx;
    this.nextStep = 0;
    this.timer = window.setInterval(() => this.pump(), 25);
    this.pump();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.arr = null;
    for (const lane of [...this.holdVoices.keys()]) this.holdOff(lane);
  }

  private pump(): void {
    const arr = this.arr;
    const ctx = this.e.ctx;
    if (!arr || !ctx) return;
    const q = 60 / arr.bpm / 4;
    const totalSteps = (arr.countInBeats + arr.reps * arr.repBeats + arr.outroBeats) * 4;
    while (this.nextStep < totalSteps) {
      const t = this.startCtx + this.nextStep * q;
      if (t > ctx.currentTime + 0.18) break;
      if (t > ctx.currentTime - 0.02) this.step(this.nextStep, t, q);
      this.nextStep++;
    }
  }

  private step(k: number, t: number, q: number): void {
    const arr = this.arr!;
    const beat = k / 4;
    const s = k % 16;
    if (beat < arr.countInBeats) {
      if (k % 4 === 0) this.stick(t, beat === 0 ? 1 : 0.7);
      if (beat >= arr.countInBeats - 1 && k % 4 === 0) this.riser(t, 4 * q);
      return;
    }
    const b = beat - arr.countInBeats;
    const repIdx = Math.floor(b / arr.repBeats);
    if (repIdx >= arr.reps) {
      if (b - arr.reps * arr.repBeats === 0 && s === 0) {
        this.kick(t, 1);
        this.crash(t, 0.9);
        this.pad(t, arr.root + 12, chordTones(0), 12 * q, 0.9);
        this.bass(t, arr.root, 10 * q, 1);
      }
      return;
    }
    const inRep = b - repIdx * arr.repBeats;
    const bar = Math.floor(inRep / 4);
    const section = arr.sections[Math.min(bar, arr.sections.length - 1)];
    const songBar = Math.floor(b / 4);
    const chordOff = arr.progression[songBar % arr.progression.length];
    const chordRoot = arr.root + chordOff;
    const tones = chordTones(chordOff);
    const energy = repIdx === 0 ? 0.75 : 1;
    const last = repIdx === arr.reps - 1;

    if (s === 0) this.pad(t, chordRoot + 12, tones, 16 * q, section === 'rest' ? 0.7 : 1);
    for (const a of arr.accents) {
      if (Math.abs(inRep - a) < 1e-6) {
        this.crash(t, 0.8);
        this.impact(t);
      }
    }
    if (section === 'build') {
      if (s === 0 || s === 8) this.kick(t, s === 0 ? 0.9 : 0.6);
      if (s % 2 === 0) this.hat(t, false, 0.25 + 0.35 * (s / 16));
      if (s >= 12 && bar === arr.sections.length - 2) this.snare(t, 0.25 + 0.1 * (s - 12));
      if (s === 0) this.bass(t, chordRoot, 8 * q, 0.7);
      if (s === 8) this.bass(t, chordRoot, 6 * q, 0.55);
      if (s === 0 && arr.sections[bar + 1] === 'drop') this.riser(t, 16 * q);
    } else if (section === 'drop') {
      if (s === 0 || s === 7 || s === 10) this.kick(t, s === 0 ? 1 : 0.8);
      if (s === 4 || s === 12) this.snare(t, 0.9);
      if (s % 2 === 0) this.hat(t, s === 14, 0.45);
      else if (energy >= 1 && (s === 13 || s === 15)) this.hat(t, false, 0.25);
      if (s === 0 || s === 7 || s === 10) this.bass(t, chordRoot + (s === 10 ? 12 : 0), (s === 0 ? 6 : 3) * q, 0.95);
      if (energy >= 1) this.pluck(t, chordRoot + 24 + tones[(s >> 1) % 3] + (s >= 8 ? 12 : 0), 0.16);
      if (last && s === 0 && bar === 0) this.crash(t, 0.5);
    } else {
      if (s === 0) this.kick(t, 0.8);
      if (s === 8) this.snare(t, 0.6);
      if (s % 4 === 0) this.hat(t, false, 0.3);
      if (s === 0) this.bass(t, chordRoot, 12 * q, 0.6);
      if (s % 4 === 2 && energy >= 1) this.pluck(t, chordRoot + 24 + tones[(s >> 2) % 3], 0.1);
    }
  }

  // ------------------------------------------------------------------ instruments

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private kick(t: number, vel: number): void {
    const ctx = this.e.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    this.env(g, t, 0.95 * vel, 0.003, 0.42);
    o.connect(g).connect(this.e.music);
    o.start(t);
    o.stop(t + 0.5);
    const d = this.e.duck.gain;
    d.cancelScheduledValues(t);
    d.setValueAtTime(0.5, t);
    d.linearRampToValueAtTime(1, t + 0.22);
  }

  private snare(t: number, vel: number): void {
    const ctx = this.e.ctx!;
    const n = this.e.noiseSrc(t, 0.25);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1900;
    f.Q.value = 0.7;
    const g = ctx.createGain();
    this.env(g, t, 0.5 * vel, 0.002, 0.2);
    n.connect(f).connect(g).connect(this.e.music);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.1);
    const g2 = ctx.createGain();
    this.env(g2, t, 0.3 * vel, 0.002, 0.11);
    o.connect(g2).connect(this.e.music);
    o.start(t);
    o.stop(t + 0.2);
  }

  private hat(t: number, open: boolean, vel: number): void {
    const ctx = this.e.ctx!;
    const n = this.e.noiseSrc(t, open ? 0.35 : 0.06);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7200;
    const g = ctx.createGain();
    this.env(g, t, 0.22 * vel, 0.001, open ? 0.28 : 0.045);
    n.connect(f).connect(g).connect(this.e.music);
  }

  private stick(t: number, vel: number): void {
    const ctx = this.e.ctx!;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = vel > 0.9 ? 1760 : 1320;
    const g = ctx.createGain();
    this.env(g, t, 0.12 * vel, 0.001, 0.05);
    o.connect(g).connect(this.e.music);
    o.start(t);
    o.stop(t + 0.08);
    this.hat(t, false, 0.6 * vel);
  }

  private crash(t: number, vel: number): void {
    const ctx = this.e.ctx!;
    const n = this.e.noiseSrc(t, 1.8);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 3800;
    const g = ctx.createGain();
    this.env(g, t, 0.24 * vel, 0.004, 1.6);
    n.connect(f).connect(g).connect(this.e.music);
  }

  private impact(t: number): void {
    const ctx = this.e.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.6);
    const g = ctx.createGain();
    this.env(g, t, 0.7, 0.005, 0.8);
    o.connect(g).connect(this.e.music);
    o.start(t);
    o.stop(t + 0.9);
  }

  private riser(t: number, dur: number): void {
    const ctx = this.e.ctx!;
    const n = this.e.noiseSrc(t, dur);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2.5;
    f.frequency.setValueAtTime(350, t);
    f.frequency.exponentialRampToValueAtTime(6500, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + dur * 0.95);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.02);
    n.connect(f).connect(g).connect(this.e.duck);
  }

  private bass(t: number, midi: number, dur: number, vel: number): void {
    const ctx = this.e.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f0 = midiHz(midi - 12);
    o.frequency.setValueAtTime(f0 * 1.5, t);
    o.frequency.exponentialRampToValueAtTime(f0, t + 0.04);
    const sh = ctx.createWaveShaper();
    sh.curve = SAT;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * vel, t + 0.01);
    g.gain.setValueAtTime(0.5 * vel, t + Math.max(0.02, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(sh).connect(g).connect(this.e.duck);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private pad(t: number, root: number, tones: number[], dur: number, vel: number): void {
    const ctx = this.e.ctx!;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(700, t);
    f.frequency.linearRampToValueAtTime(1600, t + dur * 0.6);
    f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05 * vel, t + 0.25);
    g.gain.setValueAtTime(0.05 * vel, t + dur - 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    f.connect(g).connect(this.e.duck);
    for (const tone of tones)
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiHz(root + tone);
        o.detune.value = det;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
  }

  private pluck(t: number, midi: number, vel: number): void {
    const ctx = this.e.ctx!;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = midiHz(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(3200, t);
    f.frequency.exponentialRampToValueAtTime(500, t + 0.15);
    const g = ctx.createGain();
    this.env(g, t, 0.12 * vel, 0.003, 0.16);
    o.connect(f).connect(g).connect(this.e.duck);
    o.start(t);
    o.stop(t + 0.22);
  }

  // ------------------------------------------------------------------ note feedback

  private lanePitch(lane: number): number {
    const root = (this.arr?.root ?? 45) + 24;
    return root + PENTA[lane % 5] + 12 * Math.floor(lane / 5);
  }

  /** Pitched hit sound: the lanes are a pentatonic scale, so hitting notes plays a melody. */
  hit(lane: number, j: Judgement): void {
    const ctx = this.e.ctx;
    if (!ctx || j === 'miss') return;
    const t = ctx.currentTime;
    const vel = j === 'perfect' ? 1 : j === 'great' ? 0.8 : 0.6;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midiHz(this.lanePitch(lane));
    const g = ctx.createGain();
    this.env(g, t, 0.5 * vel, 0.002, 0.2);
    o.connect(g).connect(this.e.hits);
    o.start(t);
    o.stop(t + 0.25);
    const o2 = ctx.createOscillator();
    o2.frequency.value = midiHz(this.lanePitch(lane) + 12);
    const g2 = ctx.createGain();
    this.env(g2, t, 0.18 * vel, 0.001, 0.07);
    o2.connect(g2).connect(this.e.hits);
    o2.start(t);
    o2.stop(t + 0.1);
  }

  /** Muted thud for a key press with no note. */
  stray(): void {
    const ctx = this.e.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.06);
    const g = ctx.createGain();
    this.env(g, t, 0.12, 0.002, 0.07);
    o.connect(g).connect(this.e.hits);
    o.start(t);
    o.stop(t + 0.1);
  }

  /** Soft sustained tone while a hold note is held. */
  holdOn(lane: number): void {
    const ctx = this.e.ctx;
    if (!ctx || this.holdVoices.has(lane)) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.frequency.value = midiHz(this.lanePitch(lane) - 12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.05);
    osc.connect(g).connect(this.e.hits);
    osc.start(t);
    this.holdVoices.set(lane, { osc, g });
  }

  holdOff(lane: number): void {
    const v = this.holdVoices.get(lane);
    const ctx = this.e.ctx;
    if (!v || !ctx) return;
    const t = ctx.currentTime;
    v.g.gain.cancelScheduledValues(t);
    v.g.gain.setValueAtTime(v.g.gain.value, t);
    v.g.gain.linearRampToValueAtTime(0.0001, t + 0.08);
    v.osc.stop(t + 0.1);
    this.holdVoices.delete(lane);
  }
}

const SAT = (() => {
  const c = new Float32Array(1024);
  for (let i = 0; i < c.length; i++) {
    const x = (i / (c.length - 1)) * 2 - 1;
    c[i] = Math.tanh(2.2 * x) / Math.tanh(2.2);
  }
  return c;
})();

/** Short synthesized effects: plate impacts, rep success/fail cues, UI tick. */
export class Sfx {
  private readonly e: AudioEngine;

  constructor(e: AudioEngine) {
    this.e = e;
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, when = 0, slide = 0): void {
    const ctx = this.e.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.e.sfx);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private burst(dur: number, gain: number, cutoff: number): void {
    const ctx = this.e.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = this.e.noiseSrc(t, dur);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.e.sfx);
  }

  clank(speed: number): void {
    const k = Math.min(1, speed / 3);
    this.burst(0.25, 0.35 * k + 0.05, 900);
    this.tone(95, 0.35, 'sine', 0.3 * k + 0.05, 0, 0.6);
    this.tone(410, 0.5, 'triangle', 0.05 * k, 0.005);
    this.tone(1230, 0.35, 'sine', 0.02 * k, 0.005);
  }

  success(): void {
    this.tone(660, 0.18, 'triangle', 0.12);
    this.tone(990, 0.3, 'triangle', 0.12, 0.12);
  }

  fail(): void {
    this.tone(180, 0.4, 'sawtooth', 0.06, 0, 0.5);
    this.burst(0.2, 0.08, 400);
  }

  tick(): void {
    this.tone(1320, 0.06, 'square', 0.03);
  }
}
