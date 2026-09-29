import type { Chart } from '../game/chart.ts';
import type { Judgement, RhythmGame } from '../game/rhythm.ts';
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

const J_STYLE: Record<Judgement, { text: string; color: string }> = {
  perfect: { text: 'PERFECT', color: '#ffe27a' },
  great: { text: 'GREAT', color: '#6ee7ff' },
  good: { text: 'GOOD', color: '#7dffb2' },
  miss: { text: 'MISS', color: '#ff5d6c' },
};

interface LaneView {
  id: MuscleId;
  key: string;
  hue: number;
}

/** Falling-note lanes (canvas 2D), one per player muscle, with live activation meters under the hit line. */
export class Highway {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private lanes: LaneView[] = [];
  private chart: Chart | null = null;
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

  setSong(chart: Chart | null, lanes: MuscleId[], keys: string[]): void {
    this.chart = chart;
    const n = lanes.length;
    this.lanes = lanes.map((id, i) => ({ id, key: keys[i], hue: n > 1 ? 24 + (i / (n - 1)) * 176 : 30 }));
    this.flash = lanes.map(() => ({ t: -9, j: 'miss' as Judgement }));
    this.judge = null;
    this.down.length = 0;
    for (let i = 0; i < n; i++) this.down.push(false);
    const laneW = n <= 4 ? 74 : n <= 6 ? 62 : 52;
    this.width = n * laneW + 24;
    this.canvas.style.width = `${this.width}px`;
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
    const x0 = 12,
      laneW = (W - 24) / n;
    const top = 8,
      hitY = H - 118;
    const yOf = (tn: number) => hitY - ((tn - t) / this.scroll) * (hitY - top);

    // panel
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, 'rgba(10,13,20,0.35)');
    bg.addColorStop(0.7, 'rgba(10,13,20,0.78)');
    bg.addColorStop(1, 'rgba(10,13,20,0.9)');
    g.fillStyle = bg;
    roundRect(g, 2, 0, W - 4, H, 14);
    g.fill();

    // lanes: held glow + separators
    for (let i = 0; i < n; i++) {
      const lx = x0 + i * laneW;
      const hue = this.lanes[i].hue;
      if (this.down[i]) {
        const lg = g.createLinearGradient(0, hitY, 0, top + (hitY - top) * 0.35);
        lg.addColorStop(0, `hsla(${hue},95%,60%,0.32)`);
        lg.addColorStop(1, `hsla(${hue},95%,60%,0)`);
        g.fillStyle = lg;
        g.fillRect(lx, top, laneW, hitY - top);
      }
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.018)' : 'rgba(255,255,255,0.035)';
      g.fillRect(lx, top, laneW, hitY - top);
    }
    g.strokeStyle = 'rgba(140,165,220,0.12)';
    g.lineWidth = 1;
    for (let i = 0; i <= n; i++) {
      const lx = Math.round(x0 + i * laneW) + 0.5;
      g.beginPath();
      g.moveTo(lx, top);
      g.lineTo(lx, hitY + 6);
      g.stroke();
    }

    const ch = this.chart;
    if (ch) {
      // beat and bar lines, counted from the first rep
      const b0 = Math.ceil((t - 0.3 - ch.countIn) / ch.spb);
      const b1 = Math.floor((t + this.scroll - ch.countIn) / ch.spb);
      for (let b = b0; b <= b1; b++) {
        const tb = ch.countIn + b * ch.spb;
        if (tb < -1e-6 || tb > ch.duration) continue;
        const y = yOf(tb);
        const bar = ((b % 4) + 4) % 4 === 0;
        g.strokeStyle = bar ? 'rgba(200,215,255,0.22)' : 'rgba(200,215,255,0.07)';
        g.lineWidth = bar ? 1.5 : 1;
        g.beginPath();
        g.moveTo(x0, y);
        g.lineTo(x0 + n * laneW, y);
        g.stroke();
        if (b < 0) {
          g.fillStyle = 'rgba(255,255,255,0.5)';
          g.font = '700 22px -apple-system, "PingFang SC", sans-serif';
          g.textAlign = 'center';
          g.fillText(String(-b), x0 + (n * laneW) / 2, y - 8);
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
        g.beginPath();
        g.moveTo(x0, y);
        g.lineTo(x0 + n * laneW, y);
        g.stroke();
        g.setLineDash([]);
        const tw = g.measureText(p.label).width;
        g.fillStyle = 'rgba(8,12,20,0.78)';
        roundRect(g, x0 + n * laneW - tw - 10, y - 17, tw + 8, 15, 4);
        g.fill();
        g.fillStyle = 'rgba(160,230,255,0.9)';
        g.fillText(p.label, x0 + n * laneW - 6, y - 6);
      }
    }

    // notes
    if (rg) {
      for (const st of rg.states) {
        const nt = st.note;
        if (nt.end < t - 0.3 || nt.t > t + this.scroll) continue;
        const L = this.lanes[nt.lane];
        const lx = x0 + nt.lane * laneW;
        const missed = st.judged === 'miss';
        const light = 48 + 20 * nt.strength;
        const col = missed ? 'rgba(120,125,140,0.55)' : `hsl(${L.hue},95%,${light}%)`;
        if (nt.hold) {
          if (st.tail && st.tail !== 'miss') continue;
          const broken = missed || (st.judged !== null && !st.holding);
          const yHead = st.holding ? hitY : yOf(nt.t);
          const yTail = Math.min(yHead, yOf(nt.end));
          g.fillStyle = broken ? 'rgba(120,125,140,0.3)' : `hsla(${L.hue},90%,${light}%,${st.holding ? 0.6 : 0.38})`;
          roundRect(g, lx + laneW * 0.28, yTail, laneW * 0.44, yHead - yTail, 5);
          g.fill();
          this.drawNote(g, lx, yHead, laneW, broken ? 'rgba(120,125,140,0.55)' : col, nt.strength, broken);
        } else {
          if (st.judged && st.judged !== 'miss') continue;
          this.drawNote(g, lx, yOf(nt.t), laneW, col, nt.strength, missed);
        }
      }
    }

    // hit line
    const hl = g.createLinearGradient(x0, 0, x0 + n * laneW, 0);
    hl.addColorStop(0, 'rgba(255,170,80,0.9)');
    hl.addColorStop(1, 'rgba(90,210,255,0.9)');
    g.fillStyle = hl;
    g.shadowColor = 'rgba(255,200,120,0.8)';
    g.shadowBlur = 10;
    g.fillRect(x0, hitY - 1.5, n * laneW, 3);
    g.shadowBlur = 0;

    // hit flashes
    for (let i = 0; i < n; i++) {
      const f = this.flash[i];
      const age = now - f.t;
      if (age > 0.22) continue;
      const k = 1 - age / 0.22;
      const cx = x0 + (i + 0.5) * laneW;
      const rg2 = g.createRadialGradient(cx, hitY, 2, cx, hitY, laneW * (0.6 + 0.5 * (1 - k)));
      rg2.addColorStop(0, hexA(J_STYLE[f.j].color, 0.85 * k));
      rg2.addColorStop(1, hexA(J_STYLE[f.j].color, 0));
      g.fillStyle = rg2;
      g.fillRect(cx - laneW, hitY - laneW, laneW * 2, laneW * 2);
    }

    // lane headers: key cap, muscle, live activation vs coach target
    for (let i = 0; i < n; i++) {
      const L = this.lanes[i];
      const lx = x0 + i * laneW;
      const cx = lx + laneW / 2;
      const ky = hitY + 14;
      const kw = Math.min(40, laneW - 10);
      g.fillStyle = this.down[i] ? `hsl(${L.hue},95%,62%)` : 'rgba(235,240,250,0.92)';
      roundRect(g, cx - kw / 2, ky + (this.down[i] ? 2 : 0), kw, 30, 7);
      g.fill();
      if (!this.down[i]) {
        g.fillStyle = 'rgba(110,118,130,0.9)';
        g.fillRect(cx - kw / 2 + 3, ky + 30, kw - 6, 2);
      }
      g.fillStyle = '#111';
      g.font = '800 15px "SF Mono", Menlo, monospace';
      g.textAlign = 'center';
      g.fillText(L.key, cx, ky + 21 + (this.down[i] ? 2 : 0));
      g.fillStyle = `hsl(${L.hue},80%,72%)`;
      g.font = '600 12px -apple-system, "PingFang SC", sans-serif';
      g.fillText(SHORT_NAME[L.id], cx, ky + 50);
      const mi = MI[L.id];
      const a = Math.min(1, act[mi]);
      const tg = Math.min(1, target[mi]);
      const mw = laneW - 16,
        my = ky + 60;
      g.fillStyle = 'rgba(255,255,255,0.08)';
      roundRect(g, lx + 8, my, mw, 6, 3);
      g.fill();
      g.fillStyle = `hsl(${L.hue},95%,${50 + 20 * a}%)`;
      roundRect(g, lx + 8, my, Math.max(2, mw * a), 6, 3);
      g.fill();
      g.fillStyle = '#fff';
      g.fillRect(lx + 8 + mw * tg - 1, my - 3, 2, 12);
    }

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
      g.fillText(st.text, x0 + (n * laneW) / 2, hitY - 70);
      g.shadowBlur = 0;
      g.globalAlpha = 1;
    }
    if (rg && rg.combo >= 5) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.font = '800 34px -apple-system, "Helvetica Neue", sans-serif';
      g.textAlign = 'center';
      g.fillText(String(rg.combo), x0 + (n * laneW) / 2, hitY - 110);
      g.font = '600 11px -apple-system, "PingFang SC", sans-serif';
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillText('COMBO', x0 + (n * laneW) / 2, hitY - 94);
    }
    if (this.message) {
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.font = '700 15px -apple-system, "PingFang SC", sans-serif';
      g.textAlign = 'center';
      const lines = this.message.split('\n');
      lines.forEach((ln, k) => g.fillText(ln, x0 + (n * laneW) / 2, hitY * 0.42 + k * 24));
    }
  }

  private drawNote(g: CanvasRenderingContext2D, lx: number, y: number, laneW: number, col: string, strength: number, missed: boolean): void {
    const h = 14 + 4 * strength;
    g.fillStyle = col;
    if (!missed) {
      g.shadowColor = col;
      g.shadowBlur = 6 + 10 * strength;
    }
    roundRect(g, lx + 5, y - h / 2, laneW - 10, h, 6);
    g.fill();
    g.shadowBlur = 0;
    g.fillStyle = missed ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.55)';
    roundRect(g, lx + 9, y - h / 2 + 2, laneW - 18, 3, 2);
    g.fill();
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

function hexA(hex: string, a: number): string {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}
