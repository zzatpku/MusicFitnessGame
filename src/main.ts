import * as THREE from 'three/webgpu';
import { Stage, type CameraPreset } from './render/stage.ts';
import { LifterView, type LifterStyle } from './render/lifter.ts';
import { BarbellView } from './render/barbell.ts';
import { Overlays } from './render/overlays.ts';
import { DustParticles } from './render/particles.ts';
import { Hud, type StartOptions } from './ui/hud.ts';
import { Highway, SHORT_NAME } from './ui/highway.ts';
import { BodyCues, type ScreenPoint } from './ui/bodycues.ts';
import { Input, LANE_KEYS, keyLabel } from './game/input.ts';
import { LiftSession, type RepResult } from './game/session.ts';
import { buildSong, COUNT_IN_BEATS, OUTRO_BEATS, type Song } from './game/song.ts';
import { RhythmGame, type Judgement } from './game/rhythm.ts';
import type { ExerciseId } from './game/exercises.ts';
import { MI, NM, type MuscleId } from './sim/muscles.ts';
import { AudioEngine, Music, PROGRESSIONS, Sfx } from './audio.ts';

type Phase = 'menu' | 'ready' | 'playing' | 'paused' | 'results';

const STYLE: Record<ExerciseId, LifterStyle> = {
  squat: { gripHalf: 0.4, stance: 0.165, toeOut: 0.32 },
  frontSquat: { gripHalf: 0.25, stance: 0.155, toeOut: 0.3 },
  deadlift: { gripHalf: 0.25, stance: 0.115, toeOut: 0.12 },
  // Pull from hip width (heels ~25 cm apart), land the catch in a squat stance about shoulder width.
  clean: { gripHalf: 0.29, stance: 0.12, toeOut: 0.14, catchStance: 0.19, catchToe: 0.36 },
  rdl: { gripHalf: 0.25, stance: 0.115, toeOut: 0.1 },
};

/** Phase whose downbeat gets the musical impact (the effort peak of the rep). */
const ACCENT_PHASE: Record<ExerciseId, string> = { squat: 'ascent', frontSquat: 'ascent', deadlift: 'lockout', rdl: 'drive', clean: 'second' };

async function main(): Promise<void> {
  const viewport = document.getElementById('viewport')!;
  const hudRoot = document.getElementById('hud')!;
  const stage = new Stage();
  await stage.init(viewport);

  const session = new LiftSession('squat');
  const lifter = new LifterView();
  const barbell = new BarbellView();
  const overlays = new Overlays();
  const dust = new DustParticles();
  stage.scene.add(lifter.group, barbell.group, overlays.group, dust.sprite);
  const audio = new AudioEngine();
  const music = new Music(audio);
  const sfx = new Sfx(audio);

  let phase: Phase = 'menu';
  let opts: StartOptions = { ex: 'squat', weight: 60, bpm: 84, diff: 'easy', reps: 5, auto: false, cue: 'lanes' };
  let song: Song | null = null;
  let rg: RhythmGame | null = null;
  let lanes: MuscleId[] = [];
  let keysDown: boolean[] = [];
  let startCtx = 0;
  let camIdx = 0;
  let hoverId: MuscleId | null = null;
  const cams: CameraPreset[] = ['orbit', 'side', 'front', 'back'];
  const hitGlow = new Float32Array(NM);
  const misses: { lane: number; t: number }[] = [];
  const cueGlow = new Float32Array(9);
  let anchors: (ScreenPoint | null)[] = [];
  const anchorV = new THREE.Vector3();

  const setMessage = (text: string) => {
    highway.message = opts.cue === 'body' ? '' : text;
    bodyCues.message = opts.cue === 'body' ? text : '';
  };

  // Song clock: the audio output clock when sound is running, else wall time (audio blocked).
  let audioClock = true;
  let startPerf = 0;
  let pausedAt = 0;
  const songTime = (perfMs = performance.now()) => (audioClock ? audio.heardTime(perfMs) - startCtx : (perfMs - startPerf) / 1000);

  const onJudge = (lane: number, j: Judgement, _offset: number, tail: boolean) => {
    highway.onJudge(lane, j, performance.now() / 1000);
    bodyCues.onJudge(lane, j, performance.now() / 1000, anchors[lane] ?? null);
    if (j === 'miss') {
      misses.push({ lane, t: session.time });
      if (misses.length > 64) misses.shift();
    } else {
      if (!tail) music.hit(lane, j);
      hitGlow[MI[lanes[lane]]] = 1;
    }
  };

  /** Build the chart for the chosen song and wait in the setup pose. */
  const prepare = (o: StartOptions) => {
    music.stop();
    opts = { ...o };
    song = buildSong({ ex: o.ex, weight: o.weight, bpm: o.bpm, diff: o.diff, reps: o.reps }, session);
    opts.weight = song.cfg.weight;
    lanes = song.lanes;
    keysDown = lanes.map(() => false);
    lifter.style = STYLE[o.ex];
    barbell.setWeight(session.weight);
    stage.setRack(session.ex.pins);
    input.setLanes(lanes.length);
    highway.setSong(song.chart, lanes, LANE_KEYS[lanes.length].map(keyLabel), o.cue);
    bodyCues.enabled = o.cue === 'body';
    hudRoot.style.setProperty('--hw', `${highway.width}px`);
    stage.setViewShift(o.cue === 'body' ? 0 : highway.width);
    hud.setSong(opts, lanes);
    toReady();
  };

  const toReady = () => {
    music.stop();
    audio.resume();
    session.setLanes(lanes);
    session.reset();
    rg = null;
    misses.length = 0;
    phase = 'ready';
    setMessage(opts.cue === 'body' ? '按 空格 开始\n光圈收拢到哪块肌肉，就按它的键（左下角是按键对照）' : '按 空格 开始\n开始前可以先按键，感受肌肉收紧');
    hud.showMenu(false);
    hud.showPause(false);
    hud.hideResults();
  };

  const startSong = () => {
    if (!song) return;
    const ctx = audio.ensure();
    if (!ctx) return;
    session.reset();
    session.hold.fill(0);
    rg = new RhythmGame(song.chart);
    rg.autoplay = opts.auto;
    rg.onJudge = onJudge;
    startCtx = ctx.currentTime + 0.35;
    audioClock = ctx.state === 'running';
    startPerf = performance.now() + 350;
    const plan = session.plan;
    const acc = plan.phases.find((p) => p.id === ACCENT_PHASE[opts.ex]);
    const prog = PROGRESSIONS[opts.ex];
    music.start(
      {
        bpm: opts.bpm,
        countInBeats: COUNT_IN_BEATS,
        repBeats: plan.repBeats,
        reps: opts.reps,
        outroBeats: OUTRO_BEATS,
        sections: session.ex.sections,
        root: prog.root,
        progression: prog.prog,
        accents: acc ? [Math.round((acc.t / plan.spb) * 4) / 4] : [],
      },
      startCtx,
    );
    session.startSong(song.chart.countIn, song.chart.reps);
    setMessage('');
    phase = 'playing';
  };

  const pause = () => {
    if (phase !== 'playing') return;
    phase = 'paused';
    pausedAt = performance.now();
    audio.suspend();
    hud.showPause(true);
  };

  const resume = () => {
    if (phase !== 'paused') return;
    audio.resume();
    startPerf += performance.now() - pausedAt;
    phase = 'playing';
    hud.showPause(false);
  };

  const toMenu = () => {
    music.stop();
    audio.resume();
    rg = null;
    phase = 'menu';
    session.reset();
    hud.showPause(false);
    hud.hideResults();
    hud.showMenu(true);
  };

  const finish = () => {
    if (!rg || !song) return;
    phase = 'results';
    session.drive.fill(1);
    session.excess.fill(0);
    music.stop();
    for (let l = 0; l < lanes.length; l++) music.holdOff(l);
    hud.showResults(opts, session, rg, lanes);
  };

  const hud = new Hud(hudRoot, {
    start: (o) => {
      (document.activeElement as HTMLElement | null)?.blur();
      hud.showMenu(false);
      audio.ensure();
      opts = { ...opts, cue: o.cue };
      setMessage('生成谱面中…');
      setTimeout(() => prepare(o), 30);
    },
    camera: () => {
      camIdx = (camIdx + 1) % cams.length;
      stage.setCamera(cams[camIdx]);
    },
    overlays: () => {
      const v = overlays.visible;
      const on = !(v.com && v.grf && v.path && v.torque);
      v.com = v.grf = v.path = v.torque = on;
    },
    pause,
    resume,
    restart: () => song && toReady(),
    menu: toMenu,
    help: (show) => hud.setHelp(show),
    hover: (id) => (hoverId = id),
  });
  const highway = new Highway(hudRoot);
  const bodyCues = new BodyCues(hudRoot);

  const input = new Input({
    lane: (l, down, tMs, code) => {
      if (l >= lanes.length) return;
      // Nine lanes put a lane on the space bar; outside the song it keeps its start/resume role.
      if (code === 'Space' && phase !== 'playing') {
        if (down) onAction('go');
        return;
      }
      keysDown[l] = down;
      highway.setKey(l, down);
      const m = MI[lanes[l]];
      if (phase === 'ready' || phase === 'results') {
        session.hold[m] = down ? 0.45 : 0;
        if (down) {
          audio.ensure();
          music.hit(l, 'good');
          hitGlow[m] = 1;
        }
        return;
      }
      if (phase !== 'playing' || !rg) return;
      const t = songTime(tMs);
      if (down) {
        if (rg.press(l, t) === 'stray') music.stray();
        hitGlow[m] = Math.max(hitGlow[m], 0.6);
      } else rg.release(l, t);
    },
    action: (a) => onAction(a),
  });

  function onAction(a: string): void {
    if (a === 'help') return hud.setHelp(!hud.helpOpen);
    if (hud.helpOpen) {
      if (a === 'escape' || a === 'go') hud.setHelp(false);
      return;
    }
    switch (a) {
      case 'go':
        if (phase === 'ready') startSong();
        else if (phase === 'paused') resume();
        else if (phase === 'results') toReady();
        break;
      case 'escape':
        if (phase === 'playing') pause();
        else if (phase === 'paused') resume();
        else if (phase === 'ready' || phase === 'results') toMenu();
        break;
      case 'restart':
        if (song && phase !== 'menu') toReady();
        break;
      case 'camera':
        camIdx = (camIdx + 1) % cams.length;
        stage.setCamera(cams[camIdx]);
        break;
      case 'overlays': {
        const v = overlays.visible;
        const on = !(v.com && v.grf && v.path && v.torque);
        v.com = v.grf = v.path = v.torque = on;
        break;
      }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });

  const tmp = new THREE.Vector3();
  session.onEvent = (type, data) => {
    const w = session.world;
    const [bx, by] = w.barPos();
    if (type === 'impact') {
      const v = data as number;
      sfx.clank(v);
      for (const s of [1, -1]) dust.burst(tmp.set(bx, 0.03, s * 0.78), Math.min(500, 120 + v * 140), { spread: [0.18, 0.02, 0.06], speed: 0.5 + v * 0.3, tint: 0xd8d2c4 });
    } else if (type === 'rack') {
      dust.burst(tmp.set(bx, by, 0), 160, { spread: [0.08, 0.04, 0.3], speed: 0.4 });
    } else if (type === 'rep') {
      if (w.barMode === 'hands') for (const s of [1, -1]) dust.burst(tmp.set(bx, by, s * lifter.style.gripHalf), 60, { spread: [0.03, 0.02, 0.03], speed: 0.3 });
    } else if (type === 'success') {
      const r = data as RepResult;
      sfx.success();
      hud.flash(`第 ${r.rep + 1} 次 ✓`, `动作评分 ${r.form} · ${r.details[0]}`, true);
    } else if (type === 'fail') {
      sfx.fail();
      const recent = new Map<number, number>();
      for (const m of misses) if (session.time - m.t < 3) recent.set(m.lane, (recent.get(m.lane) ?? 0) + 1);
      const top = (m: Map<number, number>) =>
        [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([l, c]) => `${SHORT_NAME[lanes[l]]}×${c}`)
          .join('、');
      const extra = new Map<number, number>();
      const clenched: string[] = [];
      if (rg)
        for (let l = 0; l < lanes.length; l++) {
          if (rg.clenching(l, session.time)) clenched.push(SHORT_NAME[lanes[l]]);
          else {
            const c = rg.straysSince(l, session.time - 3);
            if (c) extra.set(l, c);
          }
        }
      const why = [recent.size ? `漏掉：${top(recent)}` : '', extra.size ? `多按：${top(extra)}` : '', clenched.length ? `一直按住：${clenched.slice(0, 3).join('、')}` : '']
        .filter(Boolean)
        .join('　');
      hud.flash(`第 ${session.repIdx + 1} 次 ✗`, `${String(data ?? '')}${why ? `　${why}` : ''}`, false);
    }
  };

  // Start on the menu with the default song prepared behind it.
  prepare(opts);
  phase = 'menu';
  hud.showMenu(true);

  let last = performance.now();
  let hudTick = 0;
  let fpsAcc = 0,
    fpsN = 0,
    fps = 60;
  stage.renderer.setAnimationLoop(() => {
    const nowMs = performance.now();
    const dt = Math.min(0.05, (nowMs - last) / 1000);
    last = nowMs;
    fpsAcc += dt;
    fpsN++;
    if (fpsAcc > 0.5) {
      fps = fpsN / fpsAcc;
      fpsAcc = 0;
      fpsN = 0;
      hud.setBackend(`${stage.backend} · ${fps.toFixed(0)} FPS · 物理 1 kHz · 14 DOF`);
    }

    let t = 0;
    if (phase === 'playing' && rg && song) {
      t = songTime(nowMs);
      rg.update(t);
      for (let l = 0; l < lanes.length; l++) {
        const d = rg.driveAt(l, t);
        session.drive[MI[lanes[l]]] = d.ratio;
        session.excess[MI[lanes[l]]] = d.excess;
        if (rg.isHolding(l)) music.holdOn(l);
        else music.holdOff(l);
      }
      session.advanceTo(t);
      if (t > song.chart.duration + 0.3) finish();
    } else if (phase === 'paused' && song) {
      t = session.time;
    } else if (phase !== 'paused') {
      session.advanceFree(dt);
      t = phase === 'results' && song ? song.chart.duration : 0;
    }

    for (let i = 0; i < NM; i++) {
      hitGlow[i] = Math.max(0, hitGlow[i] - dt * 4);
      lifter.highlight[i] = hitGlow[i] * 0.45;
    }
    const bodyMode = opts.cue === 'body' && phase !== 'menu';
    if (bodyMode) {
      bodyCues.cueLevels(t, phase === 'playing' || phase === 'paused' ? rg : null, cueGlow);
      lanes.forEach((id, l) => (lifter.highlight[MI[id]] = Math.max(lifter.highlight[MI[id]], cueGlow[l])));
    }
    if (hoverId) lifter.highlight[MI[hoverId]] = 1;
    const w = session.world;
    lifter.catchTarget = (session.cleanStage === 'drop' || session.cleanStage === 'caught') && session.state !== 'reset' ? 1 : 0;
    lifter.update(w, phase === 'paused' ? 0 : dt);
    if (bodyMode) {
      const W = window.innerWidth,
        H = window.innerHeight;
      anchors = lanes.map((id) => {
        lifter.muscleAnchor(id, anchorV).project(stage.camera);
        return anchorV.z < 1 ? { x: ((anchorV.x + 1) / 2) * W, y: ((1 - anchorV.y) / 2) * H } : null;
      });
    }
    bodyCues.draw(t, nowMs / 1000, phase === 'playing' || phase === 'paused' ? rg : null, anchors);
    const [bx, by] = w.barPos();
    barbell.update(bx, by, w.q[13]);
    overlays.update(w, lifter, session.barTrail);
    dust.update(stage.renderer, phase === 'paused' ? 0 : dt);
    stage.update(dt);
    highway.canvas.style.display = phase === 'menu' ? 'none' : '';
    if (phase !== 'menu') highway.draw(t, nowMs / 1000, rg, w.muscles.a, session.target);
    hudTick += dt;
    if (hudTick > 1 / 30) {
      hud.update(session, rg, t, song?.chart.duration ?? 1, hudTick, keysDown, lanes);
      hudTick = 0;
    }
    stage.render();
  });
}

main().catch((err) => {
  console.error(err);
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;color:#fff;font:16px sans-serif;background:#07090d';
  d.textContent = `初始化失败：${err?.message ?? err}`;
  document.body.append(d);
});
