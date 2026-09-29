/**
 * Lane keys on the home row, split between the hands (left = legs, right = trunk and arms);
 * with nine lanes the middle one is the space bar under the thumbs.
 */
export const LANE_KEYS: Record<number, string[]> = {
  4: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  6: ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'],
  8: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
  9: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
};

export const keyLabel = (code: string): string => (code === 'Space' ? '空格' : code === 'Semicolon' ? ';' : code.replace('Key', ''));

export interface InputHandlers {
  /** Lane key pressed / released; `tMs` is the event time on the performance.now() clock. */
  lane(lane: number, down: boolean, tMs: number, code: string): void;
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
      this.h.lane(lane, down, e.timeStamp || performance.now(), e.code);
      return;
    }
    const a = ACTIONS[e.code];
    if (!a) return;
    // Space/Enter would otherwise also "click" whatever button still has focus.
    e.preventDefault();
    if (down && !e.repeat) this.h.action(a);
  }

  releaseAll(): void {
    const now = performance.now();
    for (const code of this.held) {
      const lane = this.layout.indexOf(code);
      if (lane >= 0) this.h.lane(lane, false, now, code);
    }
    this.held.clear();
  }
}
