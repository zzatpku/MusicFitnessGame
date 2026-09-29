import { EXERCISES, EXERCISE_MAP, type Difficulty, type ExerciseId } from '../game/exercises.ts';
import type { LiftSession, RepResult } from '../game/session.ts';
import type { RhythmGame } from '../game/rhythm.ts';
import { grade } from '../game/rhythm.ts';
import { LANE_COUNT, REP_OPTIONS, TEMPOS, laneMuscles, type SongConfig } from '../game/song.ts';
import { LANE_KEYS, keyLabel } from '../game/input.ts';
import { JI } from '../sim/body.ts';
import { MI, MUSCLES, type MuscleId } from '../sim/muscles.ts';
import { SHORT_NAME } from './highway.ts';

export interface StartOptions extends SongConfig {
  auto: boolean;
}

export interface HudEvents {
  start(o: StartOptions): void;
  camera(): void;
  overlays(): void;
  pause(): void;
  resume(): void;
  restart(): void;
  menu(): void;
  help(show: boolean): void;
  hover(id: MuscleId | null): void;
}

const DIFF_CN: Record<Difficulty, string> = { easy: '简单', normal: '标准', expert: '专家' };
const JOINT_ROWS: [number, string, number][] = [
  [JI.hip, '髋', 900],
  [JI.knee, '膝', 700],
  [JI.ankle, '踝', 450],
  [JI.lumbar, '腰椎', 650],
  [JI.shoulder, '肩', 160],
];

const el = (tag: string, cls = '', html = ''): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export class Hud {
  private readonly root: HTMLElement;
  private readonly ev: HudEvents;
  private songEl!: HTMLElement;
  private scoreEl!: HTMLElement;
  private comboEl!: HTMLElement;
  private accEl!: HTMLElement;
  private repsEl!: HTMLElement;
  private progEl!: HTMLElement;
  private muscleList!: HTMLElement;
  private rows: { id: MuscleId; row: HTMLElement; bar: HTMLElement; tgt: HTMLElement; tag: HTMLElement }[] = [];
  private jointEls: { ang: HTMLElement; tq: HTMLElement; bar: HTMLElement }[] = [];
  private copEl!: HTMLElement;
  private comEl!: HTMLElement;
  private balLbl!: HTMLElement;
  private spineI!: HTMLElement;
  private spineLbl!: HTMLElement;
  private phaseEl!: HTMLElement;
  private tipEl!: HTMLElement;
  private bigEl!: HTMLElement;
  private backendEl!: HTMLElement;
  private menuEl!: HTMLElement;
  private helpEl!: HTMLElement;
  private pauseEl!: HTMLElement;
  private resultEl!: HTMLElement;
  private laneKey = '';
  private bigTimer = 0;
  private pick: StartOptions = { ex: 'squat', weight: EXERCISE_MAP.squat.weight.def, bpm: 84, diff: 'easy', reps: 5, auto: false };
  private refreshMenu: () => void = () => {};

  constructor(root: HTMLElement, ev: HudEvents) {
    this.root = root;
    this.ev = ev;
    this.build();
  }

  // ------------------------------------------------------------------ build

  private build(): void {
    const r = this.root;
    const top = el('div', 'topbar panel');
    top.append(el('div', 'brand', '<b>肌动实验室</b><span>MUSCLE LAB · RHYTHM</span>'));
    this.songEl = el('div', 'songinfo', '');
    top.append(this.songEl);
    this.progEl = el('div', 'songprog', '<i></i>');
    top.append(this.progEl);
    const stat = (label: string, cls = '') => {
      const s = el('div', 'tstat ' + cls, `<small>${label}</small><b>–</b>`);
      top.append(s);
      return s.querySelector('b') as HTMLElement;
    };
    this.scoreEl = stat('得分', 'hot');
    this.comboEl = stat('连击');
    this.accEl = stat('准确率');
    this.repsEl = stat('动作');
    top.append(el('div', 'spacer'));
    const btn = (label: string, fn: () => void) => {
      const b = el('button', 'btn icon', label) as HTMLButtonElement;
      b.onclick = fn;
      top.append(b);
    };
    btn('视角 C', () => this.ev.camera());
    btn('力学叠加 V', () => this.ev.overlays());
    btn('暂停 Esc', () => this.ev.pause());
    btn('？', () => this.ev.help(true));
    r.append(top);

    const side = el('div', 'side panel');
    side.append(el('h3', '', '<span>肌群发力 · MUSCLES</span><span>白线 = 教练需求</span>'));
    this.muscleList = el('div', 'mlist');
    side.append(this.muscleList);
    side.append(el('div', 'legend', '<span style="--c:#ff8a3a">向心</span><span style="--c:#3ad7ff">离心</span><span style="--c:#ffd54a">等长</span>'));
    side.append(el('h3', 'mt', '<span>生物力学 · BIOMECHANICS</span><span>角度 / 力矩</span>'));
    for (const [, name] of JOINT_ROWS) {
      const row = el('div', 'jrow');
      const ang = el('div', 'ang', '0°');
      const bar = el('i');
      const tb = el('div', 'tbar');
      tb.append(bar);
      const tq = el('div', 'tq', '0');
      row.append(el('div', '', name), ang, tb, tq);
      side.append(row);
      this.jointEls.push({ ang, tq, bar });
    }
    const bal = el('div', 'meter');
    this.balLbl = el('div', 'lbl', '<span>平衡 · 压力中心 / 重心</span><b>足中</b>');
    const foot = el('div', 'foot');
    foot.append(el('div', 'ends', '<span>脚跟</span><span>足中</span><span>脚尖</span>'));
    this.copEl = el('div', 'mk cop');
    this.comEl = el('div', 'mk com');
    foot.append(this.copEl, this.comEl);
    bal.append(this.balLbl, foot);
    side.append(bal);
    const sp = el('div', 'meter');
    this.spineLbl = el('div', 'lbl', '<span>腰椎屈曲（弓腰风险）</span><b>0°</b>');
    const gauge = el('div', 'gauge');
    this.spineI = el('i');
    gauge.append(this.spineI);
    sp.append(this.spineLbl, gauge);
    side.append(sp);
    this.backendEl = el('div', 'backend');
    side.append(this.backendEl);
    r.append(side);

    const coach = el('div', 'coach panel');
    this.phaseEl = el('div', 'phase', '');
    this.tipEl = el('div', 'tip', '');
    coach.append(this.phaseEl, this.tipEl);
    r.append(coach);

    this.bigEl = el('div', 'bigmsg');
    r.append(this.bigEl);

    this.menuEl = this.buildMenu();
    this.helpEl = this.buildHelp();
    this.pauseEl = this.buildPause();
    this.resultEl = el('div', 'modal hidden');
    r.append(this.menuEl, this.helpEl, this.pauseEl, this.resultEl);
  }

  private seg<T extends string | number>(items: [T, string][], get: () => T, set: (v: T) => void, cls = ''): HTMLElement {
    const s = el('div', 'seg ' + cls);
    const buttons: [T, HTMLElement][] = [];
    for (const [v, label] of items) {
      const b = el('button', '', label);
      b.onclick = () => {
        set(v);
        this.refreshMenu();
      };
      buttons.push([v, b]);
      s.append(b);
    }
    const prev = this.refreshMenu;
    this.refreshMenu = () => {
      prev();
      for (const [v, b] of buttons) b.classList.toggle('on', v === get());
    };
    return s;
  }

  private buildMenu(): HTMLElement {
    const m = el('div', 'modal');
    const c = el('div', 'card panel');
    c.append(el('h1', '', '肌动实验室 · 节奏训练'));
    c.append(
      el(
        'p',
        'sub',
        '每个下落的音符 = <b>让这块肌肉再发力一点</b>。音符越密，这块肌肉需要的力量越大。打中，肌肉就按 AI 教练算出的力度收缩；漏掉，它就会松掉——人体动作由物理引擎（1000 Hz 多体动力学 + Hill 肌肉模型）实时模拟，漏得多了就会蹲不起来、拉不动或失去平衡。动作节奏与音乐小节对齐。',
      ),
    );
    c.append(el('h2', '', '选择动作'));
    const cards = el('div', 'excards');
    const cardEls: Record<string, HTMLElement> = {};
    for (const ex of EXERCISES) {
      const card = el('div', 'excard', `<b>${ex.cn}</b><small>${ex.en}</small><p>${ex.summary}</p>`);
      card.onclick = () => {
        if (this.pick.ex !== ex.id) this.pick.weight = ex.weight.def;
        this.pick.ex = ex.id;
        this.refreshMenu();
      };
      cardEls[ex.id] = card;
      cards.append(card);
    }
    c.append(cards);

    const grid = el('div', 'optgrid');
    const opt = (title: string, body: HTMLElement) => {
      const b = el('div', 'opt');
      b.append(el('h2', '', title), body);
      grid.append(b);
    };
    opt(
      '难度 · 键数',
      this.seg<Difficulty>(
        (['easy', 'normal', 'expert'] as Difficulty[]).map((d) => [d, `${DIFF_CN[d]} ${LANE_COUNT[d]}键`]),
        () => this.pick.diff,
        (v) => (this.pick.diff = v),
      ),
    );
    opt(
      '速度',
      this.seg<number>(
        TEMPOS.map((t) => [t.bpm, `${t.cn} ${t.bpm}`]),
        () => this.pick.bpm,
        (v) => (this.pick.bpm = v),
      ),
    );
    opt(
      '次数',
      this.seg<number>(
        REP_OPTIONS.map((n) => [n, `${n} 次`]),
        () => this.pick.reps,
        (v) => (this.pick.reps = v),
      ),
    );
    const w = el('div', 'weight');
    const minus = el('button', 'btn icon', '−') as HTMLButtonElement;
    const plus = el('button', 'btn icon', '+') as HTMLButtonElement;
    const kg = el('div', 'kg', '');
    const step = (d: number) => {
      const r = EXERCISE_MAP[this.pick.ex].weight;
      this.pick.weight = Math.max(r.min, Math.min(r.max, this.pick.weight + d));
      this.refreshMenu();
    };
    minus.onclick = () => step(-5);
    plus.onclick = () => step(5);
    w.append(minus, kg, plus);
    opt('重量', w);
    opt(
      '模式',
      this.seg<string>(
        [
          ['play', '挑战'],
          ['auto', '自动演示'],
        ],
        () => (this.pick.auto ? 'auto' : 'play'),
        (v) => (this.pick.auto = v === 'auto'),
        'cool',
      ),
    );
    c.append(grid);
    c.append(el('h2', '', '按键 → 肌群（左手 = 下肢，右手 = 躯干 / 上肢）'));
    const lanes = el('div', 'lanepreview');
    c.append(lanes);
    c.append(
      el(
        'p',
        'hint',
        '开始前可以先按这些键，感受对应肌肉在身上收紧。　空格 开始 · Esc 暂停 · R 重来 · C 视角 · V 力学叠加',
      ),
    );
    const cta = el('div', 'cta');
    const hb = el('button', 'btn', '说明');
    hb.onclick = () => this.ev.help(true);
    const go = el('button', 'btn primary', '开始 ▶');
    go.onclick = () => this.ev.start({ ...this.pick });
    cta.append(hb, go);
    c.append(cta);
    m.append(c);

    const prev = this.refreshMenu;
    this.refreshMenu = () => {
      prev();
      for (const k in cardEls) cardEls[k].classList.toggle('on', k === this.pick.ex);
      kg.textContent = `${this.pick.weight} kg`;
      const ids = laneMuscles(this.pick.ex, this.pick.diff);
      const keys = LANE_KEYS[ids.length];
      lanes.innerHTML = ids
        .map((id, i) => `<div class="lp"><span class="key">${keyLabel(keys[i])}</span><b>${MUSCLES[MI[id]].cn}</b><small>${MUSCLES[MI[id]].role.split('：')[0]}</small></div>`)
        .join('');
    };
    this.refreshMenu();
    return m;
  }

  private buildHelp(): HTMLElement {
    const m = el('div', 'modal hidden');
    const c = el('div', 'card panel');
    c.innerHTML = `
      <h1>怎么玩</h1>
      <p class="sub">这是一个“肌肉节奏游戏”：音乐里的每个音符都是一次发力指令，身体的动作完全由物理引擎根据你的发力模拟出来。</p>
      <h2>音符</h2>
      <ul>
        <li><b>每条轨道 = 一组肌肉</b>，底部标着按键和肌肉名。左手管下肢（小腿、股四头、腘绳、臀），右手管躯干和上肢（核心、竖脊肌、背阔、斜方、三角肌）。</li>
        <li><b>音符越密 = 这块肌肉此刻需要越大的力量</b>（像运动神经元的放电频率）。长条音符 = 持续收缩，按住到结束。</li>
        <li>音符落到发光线时按下：PERFECT ±45 ms，GREAT ±90 ms，GOOD ±135 ms。</li>
        <li>打中后这块肌肉按教练算出的力度收缩；<b>漏掉</b>后它会逐渐松弛（只剩约 30% 力量），直到你再次打中这条轨道的音符。其他肌肉会尽力代偿，但代偿不了就会失败。</li>
        <li>乱按（没有音符时按键）会让肌肉抽动一下，也会干扰动作。</li>
        <li>轨道底部的小条是这块肌肉的实时激活程度，白线是教练需要的激活。</li>
      </ul>
      <h2>动作与失败</h2>
      <ul>
        <li>每次动作占 2～3 个小节，动作的关键时刻（出底、锁定、二次发力）落在小节的强拍上。</li>
        <li>物理是真实的：股四头没力就站不起来（落到保护杠），臀腿没力会“撅屁股”，小腿失控会前后失去平衡，竖脊肌松了会弓腰。</li>
        <li>失败的一次会自动复位，下一次重新开始。结算时会看到每块肌肉的命中率。</li>
      </ul>
      <h2>画面怎么读</h2>
      <ul>
        <li>肌肉颜色：<b style="color:#ff8a3a">橙→黄白</b> = 向心收缩，<b style="color:var(--cool)">蓝</b> = 离心收缩，亮度 = 激活程度；打中音符时对应肌肉会闪一下。</li>
        <li>黄色小球 + 竖线 = 合重心；绿色箭头 = 地面反作用力（起点即压力中心）。关节圆弧 = 关节力矩。彩色轨迹 = 杠铃路径。</li>
      </ul>
      <h2>物理与生理模型</h2>
      <ul>
        <li>矢状面浮动基多刚体（9 个刚体、8 个关节）+ 杠铃，广义坐标、质量矩阵、1 kHz 半隐式积分；接触/约束用投影 Gauss–Seidel 求解。</li>
        <li>14 组 Hill 型肌肉（力-长度、力-速度、被动弹性、激活动力学）；AI 教练 = 逆动力学前馈 + 关节 PD + 静态优化分配到肌肉，负重时核心会与竖脊肌共同收缩（腹内压）。</li>
        <li>谱面由 AI 教练先完整做一遍动作、记录每块肌肉的激活曲线后自动生成；音乐由 WebAudio 实时合成。</li>
      </ul>`;
    const cta = el('div', 'cta');
    const close = el('button', 'btn primary', '明白了');
    close.onclick = () => this.ev.help(false);
    cta.append(close);
    c.append(cta);
    m.append(c);
    m.onclick = (e) => {
      if (e.target === m) this.ev.help(false);
    };
    return m;
  }

  private buildPause(): HTMLElement {
    const m = el('div', 'modal hidden');
    const c = el('div', 'card panel small');
    c.append(el('h1', '', '已暂停'));
    const cta = el('div', 'cta col');
    const b1 = el('button', 'btn primary', '继续  Esc');
    b1.onclick = () => this.ev.resume();
    const b2 = el('button', 'btn', '重新开始  R');
    b2.onclick = () => this.ev.restart();
    const b3 = el('button', 'btn', '返回选曲');
    b3.onclick = () => this.ev.menu();
    cta.append(b1, b2, b3);
    c.append(cta);
    m.append(c);
    return m;
  }

  // ------------------------------------------------------------------ state

  showMenu(show: boolean): void {
    this.menuEl.classList.toggle('hidden', !show);
    if (show) this.refreshMenu();
  }

  get menuOpen(): boolean {
    return !this.menuEl.classList.contains('hidden');
  }

  setHelp(show: boolean): void {
    this.helpEl.classList.toggle('hidden', !show);
  }

  get helpOpen(): boolean {
    return !this.helpEl.classList.contains('hidden');
  }

  showPause(show: boolean): void {
    this.pauseEl.classList.toggle('hidden', !show);
  }

  get pauseOpen(): boolean {
    return !this.pauseEl.classList.contains('hidden');
  }

  get resultsOpen(): boolean {
    return !this.resultEl.classList.contains('hidden');
  }

  hideResults(): void {
    this.resultEl.classList.add('hidden');
  }

  setBackend(text: string): void {
    this.backendEl.textContent = text;
  }

  setSong(o: StartOptions, lanes: MuscleId[]): void {
    const ex = EXERCISE_MAP[o.ex];
    this.songEl.innerHTML = `<b>${ex.cn}</b><span>${o.weight} kg · ${o.bpm} BPM · ${lanes.length} 键${o.auto ? ' · 自动演示' : ''}</span>`;
    this.rebuildRows(o.ex, lanes);
  }

  flash(text: string, sub: string, ok: boolean): void {
    this.bigEl.className = `bigmsg show ${ok ? 'ok' : 'bad'}`;
    this.bigEl.innerHTML = `${text}<small>${sub}</small>`;
    this.bigTimer = 2.4;
  }

  private rebuildRows(exId: ExerciseId, lanes: MuscleId[]): void {
    const key = exId + lanes.join();
    if (key === this.laneKey) return;
    this.laneKey = key;
    this.muscleList.innerHTML = '';
    this.rows = [];
    const keys = LANE_KEYS[lanes.length];
    const order: MuscleId[] = [...lanes, ...MUSCLES.map((m) => m.id).filter((id) => !lanes.includes(id) && id !== 'grip'), 'grip'];
    for (const id of order) {
      const spec = MUSCLES[MI[id]];
      const lane = lanes.indexOf(id);
      const row = el('div', 'mrow' + (lane >= 0 ? '' : ' auto'));
      row.append(el('div', 'key' + (lane >= 0 ? '' : ' auto'), lane >= 0 ? keyLabel(keys[lane]) : '自动'));
      const name = el('div', 'mname', `${SHORT_NAME[id]}<small>${spec.en}</small>`);
      const tag = el('span', 'mtag', '放松');
      name.append(tag);
      const bar = el('i');
      const tgt = el('b');
      const mbar = el('div', 'mbar');
      mbar.append(bar, tgt);
      row.append(name, mbar);
      row.title = `${spec.cn}：${spec.role}`;
      row.onmouseenter = () => this.ev.hover(id);
      row.onmouseleave = () => this.ev.hover(null);
      this.muscleList.append(row);
      this.rows.push({ id, row, bar, tgt, tag });
    }
  }

  // ------------------------------------------------------------------ per frame

  update(s: LiftSession, rg: RhythmGame | null, songT: number, songLen: number, dt: number, keysDown: boolean[], lanes: MuscleId[]): void {
    const w = s.world;
    const ms = w.muscles;
    const deg = (r: number) => (r * 180) / Math.PI;

    for (const r of this.rows) {
      const i = MI[r.id];
      const a = ms.a[i];
      const ecc = ms.vt[i] > 0.03 && a > 0.08;
      const con = ms.vt[i] < -0.03 && a > 0.08;
      r.bar.style.width = `${(Math.min(1, a) * 100).toFixed(1)}%`;
      r.bar.className = ecc ? 'ecc' : con ? '' : a > 0.08 ? 'iso' : '';
      r.tgt.style.left = `${Math.min(100, s.target[i] * 100).toFixed(1)}%`;
      r.tag.textContent = a < 0.08 ? '放松' : ecc ? '离心' : con ? '向心' : '等长';
      r.tag.className = 'mtag' + (a < 0.08 ? '' : ecc ? ' ecc' : con ? ' con' : ' iso');
      const lane = lanes.indexOf(r.id);
      r.row.classList.toggle('held', lane >= 0 && !!keysDown[lane]);
    }

    JOINT_ROWS.forEach(([j, , max], k) => {
      const e = this.jointEls[k];
      e.ang.textContent = `${deg(w.anat[j]).toFixed(0)}°`;
      const tau = w.tauJoint[j];
      e.tq.textContent = `${tau.toFixed(0)} N·m`;
      const f = Math.min(1, Math.abs(tau) / max) * 50;
      e.bar.style.left = tau < 0 ? `${50 - f}%` : '50%';
      e.bar.style.width = `${f}%`;
      e.bar.style.background = tau < 0 ? 'linear-gradient(90deg,#ff3b0f,#ffb04a)' : 'linear-gradient(90deg,#3ad7ff,#1f7bff)';
    });

    const [heel, toe] = w.footEdges();
    const span = toe - heel;
    const [cx] = w.com(true);
    const copRel = w.grfY > 20 ? (w.copX - heel) / span : 0.5;
    const comRel = (cx - heel) / span;
    this.copEl.style.left = `${Math.max(0, Math.min(100, copRel * 100))}%`;
    this.comEl.style.left = `${Math.max(0, Math.min(100, comRel * 100))}%`;
    const bl = this.balLbl.querySelector('b')!;
    bl.textContent = copRel < 0.2 ? '偏脚跟' : copRel > 0.8 ? '偏脚尖' : '足中 ✓';
    bl.style.color = copRel < 0.12 || copRel > 0.88 ? 'var(--bad)' : copRel < 0.2 || copRel > 0.8 ? 'var(--hot2)' : 'var(--ok)';
    const lum = deg(w.anat[JI.lumbar]);
    this.spineI.style.left = `${Math.max(0, Math.min(100, (lum / 45) * 100))}%`;
    const sl = this.spineLbl.querySelector('b')!;
    sl.textContent = `${lum.toFixed(0)}°`;
    sl.style.color = lum > 25 ? 'var(--bad)' : lum > 14 ? 'var(--hot2)' : 'var(--ok)';

    this.scoreEl.textContent = rg ? String(rg.score + s.results.reduce((a, r) => a + r.bonus, 0)) : '–';
    this.comboEl.textContent = rg ? String(rg.combo) : '–';
    this.accEl.textContent = rg && rg.judgedUnits ? `${(rg.accuracy * 100).toFixed(1)}%` : '–';
    this.repsEl.innerHTML = s.reps
      ? Array.from({ length: s.reps }, (_, k) => {
          const r = s.results.find((x) => x.rep === k);
          const cls = r ? (r.ok ? 'ok' : 'bad') : k === s.repIdx ? 'cur' : '';
          return `<span class="pip ${cls}"></span>`;
        }).join('')
      : '–';
    (this.progEl.firstElementChild as HTMLElement).style.width = `${Math.max(0, Math.min(1, songT / Math.max(1, songLen))) * 100}%`;

    const ph = s.phase;
    if (s.state === 'ready' && !s.songOn) {
      this.phaseEl.innerHTML = `准备<small>${s.ex.cn} · ${s.weight} kg</small>`;
      this.tipEl.textContent = `${ph?.tip ?? ''}　—　按下轨道按键，感受对应肌肉收紧；按 空格 开始`;
    } else if (s.repIdx < 0) {
      this.phaseEl.innerHTML = `预备<small>跟着节拍，第一次动作马上开始</small>`;
      this.tipEl.textContent = ph?.tip ?? '';
    } else if (s.state === 'done') {
      this.phaseEl.innerHTML = '完成';
      this.tipEl.textContent = '';
    } else {
      this.phaseEl.innerHTML = `${ph?.cn ?? ''}<small>第 ${s.repIdx + 1}/${s.reps} 次</small>`;
      this.tipEl.textContent = s.state === 'fail' ? s.message : ph?.tip ?? '';
    }

    if (this.bigTimer > 0) {
      this.bigTimer -= dt;
      if (this.bigTimer <= 0) this.bigEl.classList.remove('show');
    }
  }

  showResults(o: StartOptions, s: LiftSession, rg: RhythmGame, lanes: MuscleId[]): void {
    const repsOk = s.results.filter((r) => r.ok).length;
    const bonus = s.results.reduce((a, r) => a + r.bonus, 0);
    const acc = rg.finalAccuracy;
    const g = o.auto ? 'AUTO' : grade(acc, repsOk, s.reps);
    const repRow = (k: number) => {
      const r: RepResult | undefined = s.results.find((x) => x.rep === k);
      if (!r) return `<div class="rr"><span class="pip"></span>第 ${k + 1} 次 —</div>`;
      return `<div class="rr"><span class="pip ${r.ok ? 'ok' : 'bad'}"></span>第 ${k + 1} 次 ${r.ok ? `成功 · 动作评分 ${r.form}` : `失败 · ${r.reason}`}</div>`;
    };
    const muscles = lanes
      .map((id, l) => {
        const hit = rg.laneHit[l],
          miss = rg.laneMiss[l];
        const p = hit + miss ? hit / (hit + miss) : 1;
        const label = hit + miss ? `${(p * 100).toFixed(0)}%` : '—';
        return `<div class="lm"><span>${MUSCLES[MI[id]].cn}</span><div class="lb"><i style="width:${hit + miss ? (p * 100).toFixed(0) : 0}%;background:hsl(${(p * 120).toFixed(0)},80%,55%)"></i></div><b>${label}</b></div>`;
      })
      .join('');
    const worst = lanes
      .map((id, l) => [id, rg.laneMiss[l]] as const)
      .filter(([, m]) => m > 0)
      .sort((a, b) => b[1] - a[1])[0];
    const c = rg.counts;
    this.resultEl.innerHTML = '';
    const card = el('div', 'card panel results');
    card.innerHTML = `
      <div class="rhead">
        <div class="grade g${g}">${g}</div>
        <div>
          <h1>${EXERCISE_MAP[o.ex].cn} · ${o.weight} kg</h1>
          <p class="sub">${o.bpm} BPM · ${lanes.length} 键 · ${s.reps} 次${o.auto ? ' · 自动演示' : ''}</p>
          <div class="rstats">
            <div><small>总分</small><b class="hot">${rg.score + bonus}</b></div>
            <div><small>准确率</small><b>${(acc * 100).toFixed(1)}%</b></div>
            <div><small>最大连击</small><b>${rg.maxCombo}</b></div>
            <div><small>完成动作</small><b>${repsOk} / ${s.reps}</b></div>
          </div>
        </div>
      </div>
      <div class="grid2">
        <div>
          <h2>判定</h2>
          <div class="jcounts"><span class="jp">PERFECT ${c.perfect}</span><span class="jg">GREAT ${c.great}</span><span class="jd">GOOD ${c.good}</span><span class="jm">MISS ${c.miss}</span></div>
          <h2>每一次动作</h2>
          ${Array.from({ length: s.reps }, (_, k) => repRow(k)).join('')}
        </div>
        <div>
          <h2>各肌群命中率</h2>
          ${muscles}
          ${worst ? `<p class="hint">漏得最多的是 <b>${MUSCLES[MI[worst[0]]].cn}</b>：${MUSCLES[MI[worst[0]]].role}</p>` : '<p class="hint">全部肌群都跟上了节奏！</p>'}
        </div>
      </div>`;
    const cta = el('div', 'cta');
    const again = el('button', 'btn primary', '再来一次  R');
    again.onclick = () => this.ev.restart();
    const back = el('button', 'btn', '返回选曲');
    back.onclick = () => this.ev.menu();
    cta.append(back, again);
    card.append(cta);
    this.resultEl.append(card);
    this.resultEl.classList.remove('hidden');
  }
}
