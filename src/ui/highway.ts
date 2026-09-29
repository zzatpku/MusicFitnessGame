import type { Chart } from '../game/chart.ts';
import type { Judgement, RhythmGame } from '../game/rhythm.ts';
import { handOf } from '../game/input.ts';
import { MI, type MuscleId } from '../sim/muscles.ts';

export const SHORT_NAME: Record<MuscleId, string> = {
  calves: '小腿',
  tibialis: '胫前',
  quads: '股四头',
  hamstrings: '腘绳',
  glutes: '臀大肌',
  iliopsoas: '屈髋',
  core: '核心',
  erectors: '竖脊肌',
  lats: '背阔',
  traps: '斜方',
  delts: '三角肌',
  biceps: '二头',
  triceps: '三头',
  grip: '握力',
};

export const J_STYLE: Record<Judgement, { text: string; color: string }> = {
  perfect: { text: 'PERFECT', color: '#ffe27a' },
  great: { text: 'GREAT', color: '#6ee7ff' },
  good: { text: 'GOOD', color: '#7dffb2' },
  miss: { text: 'MISS', color: '#ff5d6c' },
};

/**
 * Column colours mirrored between the hands by finger (as osu!mania's default 1 2 … 2 1 layout),
 * with the thumb column in its own colour.
 */
const HUE = { 1: 195, 2: 30, 3: 48 } as const;

export type CueMode = 'lanes' | 'body';

interface LaneView {
  id: MuscleId;
  key: string;
  hue: number;
  x: number;
  w: number;
}

interface Stage {
  x: number;
  w: number;
  label: string;
}

/**
 * Falling-note lanes (canvas 2D), one per player muscle, split into one stage per hand (and a thumb
 * column for the space bar) so it is obvious which hand plays what. Live activation meters under
 * the hit line. In body-cue mode only the key legend is drawn.
 */
export class Highway {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private lanes: LaneView[] = [];
  private stages: Stage[] = [];
  private chart: Chart | null = null;
  mode: CueMode = 'lanes';
  /** Seconds of look-ahead above the hit line. */
  scroll = 1.6;
  private flash: { t: number; j: Judgement }[] = [];
  private judge: { t: number; j: Judgement } | null = null;
  private readonly down: boolean[] = [];
  width = 0;
  message = '';

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'highway';
    parent.append(this.canvas);
    this.g = this.canvas.getContext('2d')!;
  }

  setSong(chart: Chart | null, lanes: MuscleId[], keys: string[], mode: CueMode): void {
    this.chart = chart;
    this.mode = mode;
    this.canvas.classList.toggle('compact', mode === 'body');
    const n = lanes.length;
    const laneW = n <= 4 ? 70 : n <= 6 ? 60 : 50;
    const gap = 18;
    this.lanes = lanes.map((id, i) => ({ id, key: keys[i], hue: 0, x: 0, w: laneW }));
    this.stages = [];
    let x = 12;
    for (const hand of [0, 2, 1]) {
      const idx = lanes.map((_, i) => i).filter((i) => handOf(i, n) === hand);
      if (!idx.length) continue;
      const start = x;
      idx.forEach((i, p) => {
        const L = this.lanes[i];
        const fromOuter = hand === 1 ? idx.length - 1 - p : p;
        L.hue = hand === 2 ? HUE[3] : fromOuter % 2 === 0 ? HUE[1] : HUE[2];
        L.w = hand === 2 ? laneW + 10 : laneW;
        L.x = x;
        x += L.w;
      });
      this.stages.push({ x: start, w: x - start, label: hand === 0 ? '左手' : hand === 1 ? '右手' : '拇指' });
      x += gap;
    }
    this.width = x - gap + 12;
    this.canvas.style.width = `${this.width}px`;
    this.flash = lanes.map(() => ({ t: -9, j: 'miss' as Judgement }));
    this.judge = null;
    this.down.length = 0;
    for (let i = 0; i < n; i++) this.down.push(false);
  }

  laneHue(lane: number): number {
    return this.lanes[lane]?.hue ?? 195;
  }

  setKey(lane: number, down: boolean): void {
    this.down[lane] = down;
  }

  onJudge(lane: number, j: Judgement, now: number): void {
    if (j !== 'miss') this.flash[lane] = { t: now, j };
    this.judge = { t: now, j };
  }

  draw(t: number, now: number, rg: RhythmGame | null, act: Float64Array, target: Float64Array): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth,
      H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const n = this.lanes.length;
    if (!n) return;
    const body = this.mode === 'body';
    const top = 8;
    const hitY = body ? 4 : H - 118;
    const yOf = (tn: number) => hitY - ((tn - t) / this.scroll) * (hitY - top);
    const x0 = this.stages[0].x;
    const x1 = this.stages[this.stages.length - 1].x + this.stages[this.stages.length - 1].w;
    const cx = (x0 + x1) / 2;

    // one panel per hand; the gaps between them stay see-through
    for (const s of this.stages) {
      const bg = g.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, body ? 'rgba(10,13,20,0.82)' : 'rgba(10,13,20,0.35)');
      bg.addColorStop(0.7, 'rgba(10,13,20,0.8)');
      bg.addColorStop(1, 'rgba(10,13,20,0.9)');
      g.fillStyle = bg;
      roundRect(g, s.x - 6, 0, s.w + 12, H, 12);
      g.fill();
      g.strokeStyle = 'rgba(140,165,220,0.16)';
      g.lineWidth = 1;
      g.stroke();
    }

    if (!body) {
      // everything that scrolls stops a little past the hit line, above the key legend
      g.save();
      g.beginPath();
      g.rect(0, 0, W, hitY + 10);
      g.clip();
      for (let i = 0; i < n; i++) {
        const L = this.lanes[i];
        if (this.down[i]) {
          const lg = g.createLinearGradient(0, hitY, 0, top + (hitY - top) * 0.35);
          lg.addColorStop(0, `hsla(${L.hue},95%,60%,0.32)`);
          lg.addColorStop(1, `hsla(${L.hue},95%,60%,0)`);
          g.fillStyle = lg;
          g.fillRect(L.x, top, L.w, hitY - top);
        }
        g.fillStyle = `hsla(${L.hue},60%,60%,${i % 2 ? 0.025 : 0.045})`;
        g.fillRect(L.x, top, L.w, hitY - top);
      }
      g.strokeStyle = 'rgba(140,165,220,0.12)';
      g.lineWidth = 1;
      for (const s of this.stages) {
        for (const L of this.lanes) {
          if (L.x <= s.x || L.x >= s.x + s.w) continue;
          const lx = Math.round(L.x) + 0.5;
          g.beginPath();
          g.moveTo(lx, top);
          g.lineTo(lx, hitY + 6);
          g.stroke();
        }
      }

      const ch = this.chart;
      if (ch) {
        // beat and bar lines (counted from the first rep), drawn per stage
        const b0 = Math.ceil((t - 0.3 - ch.countIn) / ch.spb);
        const b1 = Math.floor((t + this.scroll - ch.countIn) / ch.spb);
        for (let b = b0; b <= b1; b++) {
          const tb = ch.countIn + b * ch.spb;
          if (tb < -1e-6 || tb > ch.duration) continue;
          const y = yOf(tb);
          const bar = ((b % 4) + 4) % 4 === 0;
          g.strokeStyle = bar ? 'rgba(200,215,255,0.22)' : 'rgba(200,215,255,0.07)';
          g.lineWidth = bar ? 1.5 : 1;
          for (const s of this.stages) {
            g.beginPath();
            g.moveTo(s.x, y);
            g.lineTo(s.x + s.w, y);
            g.stroke();
          }
          if (b < 0) {
            g.fillStyle = 'rgba(255,255,255,0.5)';
            g.font = '700 22px -apple-system, "PingFang SC", sans-serif';
            g.textAlign = 'center';
            g.fillText(String(-b), cx, y - 8);
          }
        }
        // phase markers
        g.textAlign = 'right';
        g.font = '600 11px -apple-system, "PingFang SC", sans-serif';
        for (const p of ch.phases) {
          if (p.t < t - 0.3 || p.t > t + this.scroll) continue;
          const y = yOf(p.t);
          g.strokeStyle = 'rgba(58,215,255,0.35)';
          g.setLineDash([4, 4]);
          for (const s of this.stages) {
            g.beginPath();
            g.moveTo(s.x, y);
            g.lineTo(s.x + s.w, y);
            g.stroke();
          }
          g.setLineDash([]);
          const tw = g.measureText(p.label).width;
          g.fillStyle = 'rgba(8,12,20,0.78)';
          roundRect(g, x1 - tw - 10, y - 17, tw + 8, 15, 4);
          g.fill();
          g.fillStyle = 'rgba(160,230,255,0.9)';
          g.fillText(p.label, x1 - 6, y - 6);
        }
      }

      // notes
      if (rg) {
        for (const st of rg.states) {
          const nt = st.note;
          if (nt.end < t - 0.3 || nt.t > t + this.scroll) continue;
          const L = this.lanes[nt.lane];
          const missed = st.judged === 'miss';
          const light = 50 + 18 * nt.strength;
          const col = missed ? 'rgba(120,125,140,0.55)' : `hsl(${L.hue},95%,${light}%)`;
          if (nt.hold) {
            if (st.tail && st.tail !== 'miss') continue;
            const broken = missed || (st.judged !== null && !st.holding);
            const yHead = st.holding ? hitY : yOf(nt.t);
            const yTail = Math.min(yHead, yOf(nt.end));
            g.fillStyle = broken ? 'rgba(120,125,140,0.3)' : `hsla(${L.hue},90%,${light}%,${st.holding ? 0.6 : 0.38})`;
            roundRect(g, L.x + L.w * 0.28, yTail, L.w * 0.44, yHead - yTail, 5);
            g.fill();
            this.drawNote(g, L, yHead, broken ? 'rgba(120,125,140,0.55)' : col, nt.strength, broken);
          } else {
            if (st.judged && st.judged !== 'miss') continue;
            this.drawNote(g, L, yOf(nt.t), col, nt.strength, missed);
          }
        }
      }
      g.restore();

      // hit line, per stage
      for (const s of this.stages) {
        const hl = g.createLinearGradient(s.x, 0, s.x + s.w, 0);
        hl.addColorStop(0, 'rgba(255,170,80,0.9)');
        hl.addColorStop(1, 'rgba(90,210,255,0.9)');
        g.fillStyle = hl;
        g.shadowColor = 'rgba(255,200,120,0.8)';
        g.shadowBlur = 10;
        g.fillRect(s.x, hitY - 1.5, s.w, 3);
      }
      g.shadowBlur = 0;

      // hit flashes
      for (let i = 0; i < n; i++) {
        const f = this.flash[i];
        const age = now - f.t;
        if (age > 0.22) continue;
        const k = 1 - age / 0.22;
        const L = this.lanes[i];
        const lx = L.x + L.w / 2;
        const rg2 = g.createRadialGradient(lx, hitY, 2, lx, hitY, L.w * (0.6 + 0.5 * (1 - k)));
        rg2.addColorStop(0, hexA(J_STYLE[f.j].color, 0.85 * k));
        rg2.addColorStop(1, hexA(J_STYLE[f.j].color, 0));
        g.fillStyle = rg2;
        g.fillRect(lx - L.w, hitY - L.w, L.w * 2, L.w * 2);
      }
    }

    // lane headers: key cap, muscle, live activation vs coach target. In body-cue mode each column
    // starts with the number shown on the body, pointing at the key it stands for.
    const ky = body ? 44 : hitY + 14;
    for (let i = 0; i < n; i++) {
      const L = this.lanes[i];
      const lx = L.x + L.w / 2;
      if (body) {
        g.fillStyle = 'rgba(245,248,255,0.95)';
        roundRect(g, lx - 13, 6, 26, 24, 7);
        g.fill();
        g.fillStyle = '#111';
        g.font = '800 15px "SF Mono", Menlo, monospace';
        g.textAlign = 'center';
        g.fillText(String(i + 1), lx, 23);
        g.fillStyle = 'rgba(200,210,230,0.7)';
        g.font = '700 9px -apple-system, sans-serif';
        g.fillText('▼', lx, 40);
      }
      const kw = Math.min(L.key.length > 1 ? 48 : 40, L.w - 8);
      g.fillStyle = this.down[i] ? `hsl(${L.hue},95%,62%)` : 'rgba(235,240,250,0.92)';
      roundRect(g, lx - kw / 2, ky + (this.down[i] ? 2 : 0), kw, 30, 7);
      g.fill();
      if (!this.down[i]) {
        g.fillStyle = `hsla(${L.hue},70%,45%,0.9)`;
        g.fillRect(lx - kw / 2 + 3, ky + 30, kw - 6, 2);
      }
      g.fillStyle = '#111';
      g.font = L.key.length > 1 ? '800 12px -apple-system, "PingFang SC", sans-serif' : '800 15px "SF Mono", Menlo, monospace';
      g.textAlign = 'center';
      g.fillText(L.key, lx, ky + 20 + (this.down[i] ? 2 : 0));
      g.fillStyle = `hsl(${L.hue},80%,74%)`;
      g.font = '600 12px -apple-system, "PingFang SC", sans-serif';
      g.fillText(SHORT_NAME[L.id], lx, ky + 50);
      const mi = MI[L.id];
      const a = Math.min(1, act[mi]);
      const tg = Math.min(1, target[mi]);
      const mw = L.w - 14,
        my = ky + 60;
      g.fillStyle = 'rgba(255,255,255,0.08)';
      roundRect(g, L.x + 7, my, mw, 6, 3);
      g.fill();
      g.fillStyle = `hsl(${L.hue},95%,${50 + 20 * a}%)`;
      roundRect(g, L.x + 7, my, Math.max(2, mw * a), 6, 3);
      g.fill();
      g.fillStyle = '#fff';
      g.fillRect(L.x + 7 + mw * tg - 1, my - 3, 2, 12);
    }
    g.fillStyle = 'rgba(160,175,200,0.55)';
    g.font = '600 10px -apple-system, "PingFang SC", sans-serif';
    g.textAlign = 'center';
    for (const s of this.stages) g.fillText(s.label, s.x + s.w / 2, ky + 80);

    if (body) return;
    // judgement + combo
    if (this.judge && now - this.judge.t < 0.45) {
      const age = now - this.judge.t;
      const st = J_STYLE[this.judge.j];
      g.globalAlpha = 1 - age / 0.45;
      g.fillStyle = st.color;
      g.font = `800 ${Math.round(24 + 6 * Math.max(0, 1 - age * 8))}px -apple-system, "Helvetica Neue", sans-serif`;
      g.textAlign = 'center';
      g.shadowColor = st.color;
      g.shadowBlur = 16;
      g.fillText(st.text, cx, hitY - 70);
      g.shadowBlur = 0;
      g.globalAlpha = 1;
    }
    if (rg && rg.combo >= 5) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.font = '800 34px -apple-system, "Helvetica Neue", sans-serif';
      g.textAlign = 'center';
      g.fillText(String(rg.combo), cx, hitY - 110);
      g.font = '600 11px -apple-system, "PingFang SC", sans-serif';
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillText('COMBO', cx, hitY - 94);
    }
    if (this.message) {
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.font = '700 15px -apple-system, "PingFang SC", sans-serif';
      g.textAlign = 'center';
      this.message.split('\n').forEach((ln, k) => g.fillText(ln, cx, hitY * 0.42 + k * 24));
    }
  }

  private drawNote(g: CanvasRenderingContext2D, L: LaneView, y: number, col: string, strength: number, missed: boolean): void {
    const h = 14 + 4 * strength;
    g.fillStyle = col;
    if (!missed) {
      g.shadowColor = col;
      g.shadowBlur = 6 + 10 * strength;
    }
    roundRect(g, L.x + 4, y - h / 2, L.w - 8, h, 6);
    g.fill();
    g.shadowBlur = 0;
    g.fillStyle = missed ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.55)';
    roundRect(g, L.x + 8, y - h / 2 + 2, L.w - 16, 3, 2);
    g.fill();
  }
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

export function hexA(hex: string, a: number): string {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}
