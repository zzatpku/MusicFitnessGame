import type { Judgement, RhythmGame } from '../game/rhythm.ts';
import { J_STYLE, hexA, roundRect } from './highway.ts';

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * No-lane cue mode: notes appear on the body itself. An approach ring shrinks onto the muscle and
 * closes exactly at the hit time; which key it is has to be read from the body.
 */
export class BodyCues {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  /** Seconds a ring takes to close. */
  lead = 1.0;
  /** The key name fades in on the target over the last part of the approach (seconds before the hit). */
  labelLead = 0.6;
  enabled = false;
  message = '';
  /** Key label per lane. */
  keys: string[] = [];
  private pops: { lane: number; j: Judgement; t: number; at: ScreenPoint }[] = [];

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'bodycues';
    parent.prepend(this.canvas);
    this.g = this.canvas.getContext('2d')!;
  }

  onJudge(lane: number, j: Judgement, now: number, at: ScreenPoint | null): void {
    if (!at) return;
    this.pops.push({ lane, j, t: now, at: { x: at.x, y: at.y } });
    if (this.pops.length > 40) this.pops.shift();
  }

  /** 0..1 glow for each lane's muscle: ramps up while its ring closes, stays on while a hold runs. */
  cueLevels(t: number, rg: RhythmGame | null, out: Float32Array): void {
    out.fill(0);
    if (!rg) return;
    for (const st of rg.states) {
      const n = st.note;
      if (n.t - t > this.lead || n.end < t - 0.05) continue;
      let v = 0;
      if (st.judged === null) v = Math.max(0, 1 - Math.max(0, n.t - t) / this.lead) ** 2;
      else if (n.hold && st.holding) v = 1;
      out[n.lane] = Math.max(out[n.lane], v);
    }
  }

  draw(t: number, now: number, rg: RhythmGame | null, anchors: (ScreenPoint | null)[]): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth,
      H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!this.enabled) return;
    const R0 = 56,
      R1 = 12;
    const label = new Map<number, number>();

    if (rg) {
      for (const st of rg.states) {
        const n = st.note;
        const at = anchors[n.lane];
        if (!at || n.t - t > this.lead || n.end < t - 0.2) continue;
        if ((st.judged === null && t < n.t + 0.14) || (n.hold && st.holding)) {
          const a = n.hold && st.holding ? 1 : Math.max(0, Math.min(1, (this.labelLead - (n.t - t)) / (0.5 * this.labelLead)));
          label.set(n.lane, Math.max(label.get(n.lane) ?? 0, a));
        }
        if (n.hold && st.holding) {
          // a held contraction: filled target with the remaining time as an arc
          const left = Math.max(0, Math.min(1, (n.end - t) / Math.max(0.05, n.end - n.t)));
          g.fillStyle = 'rgba(255,230,140,0.35)';
          g.beginPath();
          g.arc(at.x, at.y, R1 + 4, 0, Math.PI * 2);
          g.fill();
          g.strokeStyle = 'rgba(255,225,120,0.95)';
          g.lineWidth = 4;
          g.beginPath();
          g.arc(at.x, at.y, R1 + 10, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2);
          g.stroke();
          continue;
        }
        if (st.judged !== null) continue;
        const dt = n.t - t;
        const p = Math.max(0, Math.min(1, 1 - dt / this.lead));
        const late = dt < 0;
        const r = late ? R1 : R1 + (R0 - R1) * (1 - p);
        const alpha = late ? 0.55 + 0.45 * Math.abs(Math.sin(now * 30)) : 0.25 + 0.75 * p;
        g.fillStyle = `rgba(255,255,255,${(0.1 + 0.25 * p).toFixed(3)})`;
        g.beginPath();
        g.arc(at.x, at.y, R1, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = `rgba(255,255,255,${(0.35 + 0.6 * p).toFixed(3)})`;
        g.lineWidth = 2;
        g.stroke();
        g.strokeStyle = `rgba(150,235,255,${alpha.toFixed(3)})`;
        g.lineWidth = n.hold ? 5 : 3;
        g.shadowColor = 'rgba(120,220,255,0.9)';
        g.shadowBlur = 10;
        g.beginPath();
        g.arc(at.x, at.y, r, 0, Math.PI * 2);
        g.stroke();
        g.shadowBlur = 0;
      }
    }

    // key name on the target, fading in as the ring closes (once per lane)
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const [lane, a] of label) {
      const at = anchors[lane];
      const key = this.keys[lane];
      if (!at || !key || a <= 0.01) continue;
      g.font = key.length > 1 ? '800 12px -apple-system, "PingFang SC", sans-serif' : '800 15px "SF Mono", Menlo, monospace';
      const w = Math.max(24, g.measureText(key).width + 12);
      g.globalAlpha = a;
      g.fillStyle = 'rgba(245,248,255,0.95)';
      roundRect(g, at.x - w / 2, at.y - 12, w, 24, 7);
      g.fill();
      g.fillStyle = '#111';
      g.fillText(key, at.x, at.y + 1);
      g.globalAlpha = 1;
    }
    g.textBaseline = 'alphabetic';

    // judgement pop-ups at the muscle
    g.textAlign = 'center';
    this.pops = this.pops.filter((p) => now - p.t < 0.6);
    for (const p of this.pops) {
      const age = now - p.t;
      const k = 1 - age / 0.6;
      const st = J_STYLE[p.j];
      if (p.j !== 'miss') {
        g.strokeStyle = hexA(st.color, 0.8 * k);
        g.lineWidth = 3;
        g.beginPath();
        g.arc(p.at.x, p.at.y, R1 + 40 * (1 - k), 0, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = hexA(st.color, k);
      g.font = '800 15px -apple-system, "Helvetica Neue", sans-serif';
      g.fillText(st.text, p.at.x, p.at.y - 26 - 14 * (1 - k));
    }

    if (rg && rg.combo >= 5) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.font = '800 30px -apple-system, "Helvetica Neue", sans-serif';
      g.fillText(`${rg.combo}`, W / 2, 112);
      g.font = '600 11px -apple-system, "PingFang SC", sans-serif';
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillText('COMBO', W / 2, 128);
    }
    if (this.message) {
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.font = '700 17px -apple-system, "PingFang SC", sans-serif';
      g.shadowColor = 'rgba(0,0,0,0.8)';
      g.shadowBlur = 8;
      this.message.split('\n').forEach((ln, k) => g.fillText(ln, W / 2, H * 0.3 + k * 26));
      g.shadowBlur = 0;
    }
  }
}
