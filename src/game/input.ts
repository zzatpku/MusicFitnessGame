/** Lane keys on the home row, split between the hands (left = legs, right = trunk and arms). */
export const LANE_KEYS: Record<number, string[]> = {
  4: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  6: ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'],
  9: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'],
};

export const keyLabel = (code: string): string => code.replace('Key', '');

export interface InputHandlers {
  /** Lane key pressed / released; `tMs` is the event time on the performance.now() clock. */
  lane(lane: number, down: boolean, tMs: number): void;
  action(name: string): void;
}

const ACTIONS: Record<string, string> = {
  Space: 'go',
  Enter: 'go',
  Escape: 'escape',
  KeyP: 'escape',
  KeyR: 'restart',
  KeyC: 'camera',
  KeyV: 'overlays',
  Slash: 'help',
  F1: 'help',
};

export class Input {
  private layout: string[] = LANE_KEYS[4];
  private readonly held = new Set<string>();
  private readonly h: InputHandlers;

  constructor(h: InputHandlers) {
    this.h = h;
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.releaseAll());
  }

  setLanes(n: number): void {
    this.releaseAll();
    this.layout = LANE_KEYS[n] ?? LANE_KEYS[4];
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const lane = this.layout.indexOf(e.code);
    if (lane >= 0) {
      e.preventDefault();
      if (e.repeat || down === this.held.has(e.code)) return;
      if (down) this.held.add(e.code);
      else this.held.delete(e.code);
      this.h.lane(lane, down, e.timeStamp || performance.now());
      return;
    }
    const a = ACTIONS[e.code];
    if (a && down && !e.repeat) {
      e.preventDefault();
      this.h.action(a);
    }
  }

  releaseAll(): void {
    const now = performance.now();
    for (const code of this.held) {
      const lane = this.layout.indexOf(code);
      if (lane >= 0) this.h.lane(lane, false, now);
    }
    this.held.clear();
  }
}
