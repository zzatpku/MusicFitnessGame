import * as THREE from 'three/webgpu';
import { attribute, clamp, color, float, mix, normalView, positionViewDirection, sin, smoothstep, time, uv } from 'three/tsl';
import { B, GEO } from '../sim/body.ts';
import { MI, NM, type MuscleId } from '../sim/muscles.ts';
import type { LifterWorld } from '../sim/world.ts';

type Seg = 'pelvis' | 'lumbar' | 'thorax' | 'girdle' | 'thigh' | 'shank' | 'foot' | 'uarm' | 'farm';

class Frame {
  readonly o = new THREE.Vector3();
  readonly x = new THREE.Vector3(1, 0, 0);
  readonly y = new THREE.Vector3(0, 1, 0);
  readonly z = new THREE.Vector3(0, 0, 1);
  readonly m = new THREE.Matrix4();

  point(lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.o).addScaledVector(this.x, lx).addScaledVector(this.y, ly).addScaledVector(this.z, lz);
  }

  /** Planar frame (rotation θ about z) at origin (x, y, zOff). */
  planar(ox: number, oy: number, th: number, zOff = 0): void {
    const c = Math.cos(th),
      s = Math.sin(th);
    this.o.set(ox, oy, zOff);
    this.x.set(c, s, 0);
    this.y.set(-s, c, 0);
    this.z.set(0, 0, 1);
    this.sync();
  }

  /** Limb frame: y along (proximal − distal), x = `fwd` orthogonalised. */
  limb(proximal: THREE.Vector3, distal: THREE.Vector3, fwd: THREE.Vector3): void {
    this.o.copy(proximal);
    this.y.subVectors(proximal, distal).normalize();
    this.x.copy(fwd).addScaledVector(this.y, -fwd.dot(this.y)).normalize();
    this.z.crossVectors(this.x, this.y).normalize();
    this.sync();
  }

  sync(): void {
    this.m.makeBasis(this.x, this.y, this.z).setPosition(this.o);
  }
}

type PathPt = [Seg, number, number, number];

interface MuscleVis {
  src: [MuscleId, number][];
  path: PathPt[];
  r: number;
  rw?: number;
  rt?: number;
  belly?: [number, number];
  tendon?: number;
}

const MV: MuscleVis[] = [
  { src: [['quads', 1]], r: 0.034, rt: 0.85, belly: [0.04, 0.72], path: [['thigh', 0.05, 0.01, 0.02], ['thigh', 0.07, -0.14, 0.01], ['thigh', 0.066, -0.3, 0.005], ['thigh', 0.056, -0.41, 0], ['shank', 0.045, -0.05, 0]] },
  { src: [['quads', 1]], r: 0.042, rw: 0.95, rt: 0.8, belly: [0.03, 0.9], path: [['thigh', 0.02, -0.05, 0.05], ['thigh', 0.036, -0.18, 0.06], ['thigh', 0.04, -0.33, 0.05], ['thigh', 0.046, -0.42, 0.03]] },
  { src: [['quads', 1]], r: 0.036, belly: [0.05, 0.92], path: [['thigh', 0.03, -0.2, -0.035], ['thigh', 0.046, -0.33, -0.045], ['thigh', 0.05, -0.415, -0.028]] },
  { src: [['hamstrings', 1]], r: 0.034, belly: [0.08, 0.78], path: [['pelvis', -0.07, -0.06, 0.06], ['thigh', -0.05, -0.1, 0.03], ['thigh', -0.052, -0.27, 0.035], ['thigh', -0.04, -0.4, 0.035], ['shank', -0.025, -0.05, 0.035]] },
  { src: [['hamstrings', 1]], r: 0.033, belly: [0.08, 0.75], path: [['pelvis', -0.07, -0.06, 0.035], ['thigh', -0.05, -0.1, -0.012], ['thigh', -0.052, -0.27, -0.025], ['thigh', -0.04, -0.4, -0.03], ['shank', -0.02, -0.06, -0.03]] },
  { src: [['glutes', 1]], r: 0.066, rw: 1.25, rt: 0.85, belly: [0, 0.8], path: [['pelvis', -0.11, 0.07, 0.04], ['pelvis', -0.135, -0.01, 0.085], ['thigh', -0.04, -0.09, 0.07], ['thigh', -0.01, -0.16, 0.07]] },
  { src: [['glutes', 0.55]], r: 0.042, rw: 1.2, rt: 0.7, belly: [0, 0.85], path: [['pelvis', -0.03, 0.12, 0.13], ['pelvis', -0.01, 0.04, 0.155], ['thigh', 0, -0.02, 0.09]] },
  { src: [['glutes', 0.5], ['hamstrings', 0.3]], r: 0.042, belly: [0.05, 0.85], path: [['pelvis', 0.04, -0.06, 0.02], ['thigh', 0.01, -0.12, -0.05], ['thigh', 0, -0.28, -0.045], ['thigh', 0, -0.37, -0.035]] },
  { src: [['iliopsoas', 1]], r: 0.028, belly: [0, 0.8], path: [['lumbar', 0.02, 0.05, 0.05], ['pelvis', 0.07, 0.03, 0.07], ['thigh', 0.035, -0.07, 0]] },
  { src: [['calves', 1]], r: 0.034, belly: [0.06, 0.52], path: [['thigh', -0.035, -0.4, 0.028], ['shank', -0.052, -0.07, 0.03], ['shank', -0.046, -0.19, 0.022], ['shank', -0.03, -0.33, 0.008], ['foot', -0.062, -0.03, 0]] },
  { src: [['calves', 1]], r: 0.037, belly: [0.06, 0.56], path: [['thigh', -0.035, -0.4, -0.02], ['shank', -0.057, -0.07, -0.025], ['shank', -0.05, -0.2, -0.018], ['shank', -0.03, -0.34, -0.004], ['foot', -0.062, -0.03, 0]] },
  { src: [['calves', 1]], r: 0.03, rw: 1.25, rt: 0.6, belly: [0.05, 0.75], path: [['shank', -0.032, -0.14, 0], ['shank', -0.042, -0.27, 0], ['shank', -0.03, -0.37, 0], ['foot', -0.06, -0.03, 0]] },
  { src: [['tibialis', 1]], r: 0.022, belly: [0.05, 0.62], path: [['shank', 0.032, -0.05, 0.025], ['shank', 0.036, -0.22, 0.022], ['shank', 0.034, -0.38, 0.005], ['foot', 0.05, -0.045, -0.02]] },
  { src: [['core', 1]], r: 0.03, rw: 1.45, rt: 0.45, belly: [0.05, 0.95], path: [['pelvis', 0.1, 0.02, 0.035], ['lumbar', 0.115, 0.08, 0.042], ['thorax', 0.13, 0.04, 0.048], ['thorax', 0.145, 0.17, 0.05]] },
  { src: [['core', 1]], r: 0.04, rw: 1.3, rt: 0.45, belly: [0, 1], path: [['pelvis', 0.03, 0.14, 0.125], ['lumbar', 0.06, 0.09, 0.135], ['thorax', 0.08, 0.07, 0.13]] },
  { src: [['erectors', 1]], r: 0.032, rt: 0.9, belly: [0.02, 0.95], path: [['pelvis', -0.1, 0.03, 0.03], ['lumbar', -0.075, 0.08, 0.035], ['thorax', -0.08, 0.06, 0.033], ['thorax', -0.075, 0.26, 0.025]] },
  { src: [['lats', 1]], r: 0.05, rw: 1.55, rt: 0.42, belly: [0, 0.82], path: [['lumbar', -0.085, 0.06, 0.03], ['thorax', -0.105, 0.09, 0.1], ['thorax', -0.07, 0.19, 0.16], ['uarm', 0.005, -0.08, -0.01]] },
  { src: [['traps', 1]], r: 0.04, rw: 1.3, rt: 0.55, belly: [0, 0.9], path: [['thorax', -0.055, 0.37, 0.02], ['thorax', -0.065, 0.32, 0.1], ['girdle', -0.03, 0.035, 0.17]] },
  { src: [['traps', 1]], r: 0.035, rw: 1.4, rt: 0.45, belly: [0, 1], path: [['thorax', -0.085, 0.3, 0.03], ['thorax', -0.1, 0.22, 0.08], ['thorax', -0.095, 0.12, 0.04]] },
  { src: [['delts', 1]], r: 0.042, belly: [0, 0.8], path: [['girdle', 0.045, 0.01, 0.16], ['girdle', 0.02, 0.045, 0.2], ['uarm', 0.01, -0.13, 0.025]] },
  { src: [['delts', 0.7], ['lats', 0.2]], r: 0.038, belly: [0, 0.8], path: [['girdle', -0.05, 0.015, 0.16], ['girdle', -0.02, 0.045, 0.2], ['uarm', -0.012, -0.12, 0.025]] },
  { src: [['delts', 0.5]], r: 0.05, rw: 1.55, rt: 0.42, belly: [0, 0.85], path: [['thorax', 0.145, 0.24, 0.008], ['thorax', 0.14, 0.2, 0.08], ['uarm', 0.02, -0.06, -0.012]] },
  { src: [['biceps', 1]], r: 0.028, belly: [0.15, 0.82], path: [['girdle', 0.035, -0.015, 0.17], ['uarm', 0.034, -0.1, 0], ['uarm', 0.036, -0.24, 0], ['farm', 0.022, -0.04, 0]] },
  { src: [['triceps', 1]], r: 0.033, belly: [0.1, 0.82], path: [['girdle', -0.035, -0.03, 0.17], ['uarm', -0.036, -0.1, 0], ['uarm', -0.036, -0.25, 0], ['farm', -0.028, 0.02, 0]] },
  { src: [['grip', 1]], r: 0.023, belly: [0.05, 0.65], path: [['farm', 0.016, -0.02, -0.012], ['farm', 0.026, -0.11, -0.01], ['farm', 0.016, -0.235, 0]] },
  { src: [['biceps', 0.6], ['grip', 0.3]], r: 0.021, belly: [0.05, 0.7], path: [['uarm', 0.022, -0.24, 0.022], ['farm', 0.03, -0.06, 0.016], ['farm', 0.02, -0.2, 0.01]] },
];

const RINGS = 16;
const RADIAL = 12;
const SAMPLES = RINGS;

export interface LifterStyle {
  gripHalf: number;
  /** Half distance between the ankles (m) and toe-out angle (rad). */
  stance: number;
  toeOut: number;
  /** Clean: the feet jump out to this receiving stance for the catch. */
  catchStance?: number;
  catchToe?: number;
}

const TMP = Array.from({ length: 8 }, () => new THREE.Vector3());

/** Body mannequin + dynamic muscle tubes driven by the planar simulation. */
export class LifterView {
  readonly group = new THREE.Group();
  style: LifterStyle = { gripHalf: 0.26, stance: 0.13, toeOut: 0.18 };
  highlight: Float32Array = new Float32Array(NM);
  /** 1 while the clean is being received (feet out in the landing stance), else 0. */
  catchTarget = 0;
  private catchBlend = 0;
  private hop = 0;
  private prevMode = '';
  private rackT = 9;
  private readonly elbDir = [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, -1, 0)];
  private readonly turnFrom = [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, -1, 0)];

  private readonly frames: Record<string, Frame> = {};
  private readonly bodyMeshes: { mesh: THREE.Mesh; frame: string; local: THREE.Matrix4 }[] = [];
  private readonly muscleGeo = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  private readonly act: Float32Array;
  private readonly ecc: Float32Array;
  private readonly tendon: Float32Array;
  private readonly glowSel: Float32Array;
  private readonly restLen: Float32Array;
  private readonly tubes: { vis: MuscleVis; side: number; offset: number }[] = [];
  private readonly pathPts: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());
  private readonly samples: THREE.Vector3[] = Array.from({ length: SAMPLES }, () => new THREE.Vector3());
  private initRest = false;

  constructor() {
    for (const n of ['pelvis', 'lumbar', 'thorax', 'girdle', 'thighR', 'thighL', 'shankR', 'shankL', 'footR', 'footL', 'uarmR', 'uarmL', 'farmR', 'farmL', 'head'])
      this.frames[n] = new Frame();
    this.buildBody();
    const count = MV.length * 2;
    const nv = count * RINGS * RADIAL;
    this.pos = new Float32Array(nv * 3);
    this.nor = new Float32Array(nv * 3);
    this.act = new Float32Array(nv);
    this.ecc = new Float32Array(nv);
    this.tendon = new Float32Array(nv);
    this.glowSel = new Float32Array(nv);
    this.restLen = new Float32Array(count);
    const uvs = new Float32Array(nv * 2);
    const idx: number[] = [];
    let t = 0;
    for (const vis of MV) {
      for (const side of [1, -1]) {
        const offset = t * RINGS * RADIAL;
        this.tubes.push({ vis, side, offset });
        for (let r = 0; r < RINGS; r++) {
          for (let k = 0; k < RADIAL; k++) {
            const v = offset + r * RADIAL + k;
            uvs[v * 2] = r / (RINGS - 1);
            uvs[v * 2 + 1] = k / RADIAL;
            if (r < RINGS - 1) {
              const a = v,
                b = offset + r * RADIAL + ((k + 1) % RADIAL),
                c = offset + (r + 1) * RADIAL + k,
                d = offset + (r + 1) * RADIAL + ((k + 1) % RADIAL);
              idx.push(a, b, c, b, d, c);
            }
          }
        }
        t++;
      }
    }
    const g = this.muscleGeo;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setAttribute('act', new THREE.BufferAttribute(this.act, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('ecc', new THREE.BufferAttribute(this.ecc, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('tendon', new THREE.BufferAttribute(this.tendon, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('sel', new THREE.BufferAttribute(this.glowSel, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 3);
    const mesh = new THREE.Mesh(g, this.muscleMaterial());
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------- materials

  private muscleMaterial(): THREE.MeshPhysicalNodeMaterial {
    const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.42, metalness: 0.0, clearcoat: 0.35, clearcoatRoughness: 0.35 });
    const a = attribute<'float'>('act', 'float');
    const e = attribute<'float'>('ecc', 'float');
    const td = attribute<'float'>('tendon', 'float');
    const sel = attribute<'float'>('sel', 'float');
    const u = uv();
    const fiber = sin(u.y.mul(Math.PI * 2 * 9).add(u.x.mul(3))).mul(0.5).add(0.5);
    const meat = mix(color(0x5e1d1a), color(0x93382e), fiber.mul(0.35).add(0.45));
    const base = mix(meat, color(0xd9cbb3), td);
    const heat = mix(color(0xff3b0f), color(0xffe07a), smoothstep(0.45, 1.0, a));
    const glowCol = mix(heat, color(0x46b4ff), clamp(e, 0, 1));
    const pulse = sin(u.x.mul(16).sub(time.mul(a.mul(9).add(2)))).mul(0.5).add(0.5).pow(4);
    const rimV = float(1).sub(normalView.dot(positionViewDirection).saturate()).pow(2);
    const live = a.mul(td.oneMinus());
    m.colorNode = mix(base, glowCol.mul(0.8), live.mul(0.55));
    m.emissiveNode = glowCol
      .mul(live.mul(live).mul(0.95).mul(pulse.mul(0.5).add(0.6)))
      .add(glowCol.mul(rimV.mul(live).mul(0.55)))
      .add(color(0x7fd8ff).mul(sel.mul(rimV.mul(0.9).add(0.12))));
    return m;
  }

  private bodyMaterial(): THREE.MeshStandardNodeMaterial {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.05 });
    m.colorNode = color(0x2a2e36);
    const rim = float(1).sub(normalView.dot(positionViewDirection).saturate()).pow(3);
    m.emissiveNode = color(0x3a6fd8).mul(rim.mul(0.55));
    return m;
  }

  // ---------------------------------------------------------------- body

  private addBody(frame: string, geo: THREE.BufferGeometry, mat: THREE.Material, local = new THREE.Matrix4()): void {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.bodyMeshes.push({ mesh, frame, local });
  }

  private capsule(len: number, r1: number, r2: number): THREE.BufferGeometry {
    const pts: THREE.Vector2[] = [];
    const n = 8;
    for (let i = 0; i <= n; i++) {
      const a = -Math.PI / 2 + (i / n) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.cos(a) * r2, -len + Math.sin(a) * r2));
    }
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.cos(a) * r1, Math.sin(a) * r1));
    }
    return new THREE.LatheGeometry(pts, 20);
  }

  private ellipsoid(rx: number, ry: number, rz: number): THREE.BufferGeometry {
    const g = new THREE.SphereGeometry(1, 28, 20);
    g.scale(rx, ry, rz);
    return g;
  }

  private buildBody(): void {
    const skin = this.bodyMaterial();
    const shoe = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.5 });
    const sole = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.7 });
    const visorMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.15, metalness: 0.6 });
    visorMat.colorNode = color(0x0b1220);
    visorMat.emissiveNode = color(0x39c6ff).mul(0.9);
    const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

    this.addBody('pelvis', this.ellipsoid(0.12, 0.11, 0.165), skin, T(-0.02, 0.04, 0));
    this.addBody('lumbar', this.ellipsoid(0.105, 0.12, 0.145), skin, T(0.03, 0.09, 0));
    this.addBody('thorax', this.ellipsoid(0.125, 0.175, 0.168), skin, T(0.035, 0.17, 0));
    const sh = this.capsule(0.3, 0.058, 0.058);
    this.addBody('thorax', sh, skin, new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(T(0.02, 0.275, -0.15)));
    this.addBody('head', this.capsule(0.09, 0.05, 0.052), skin, T(0, 0.09, 0));
    this.addBody('head', this.ellipsoid(0.098, 0.118, 0.086), skin, T(0.012, 0.17, 0));
    const visor = new THREE.SphereGeometry(0.1, 24, 8, -0.9, 1.8, Math.PI * 0.42, Math.PI * 0.12);
    this.addBody('head', visor, visorMat, T(0.02, 0.18, 0).multiply(new THREE.Matrix4().makeScale(1.02, 1.1, 0.95)));

    for (const s of ['R', 'L']) {
      this.addBody('thigh' + s, this.capsule(GEO.thigh, 0.07, 0.05), skin);
      this.addBody('shank' + s, this.capsule(GEO.shank, 0.05, 0.034), skin);
      this.addBody('shank' + s, new THREE.SphereGeometry(0.052, 18, 14), skin);
      const shoeGeo = new THREE.BoxGeometry(0.27, 0.07, 0.105, 2, 1, 1);
      this.addBody('foot' + s, shoeGeo, shoe, T(0.065, -0.045, 0));
      this.addBody('foot' + s, new THREE.BoxGeometry(0.275, 0.014, 0.108), sole, T(0.065, -0.074, 0));
      this.addBody('uarm' + s, this.capsule(GEO.upperArm, 0.047, 0.037), skin);
      this.addBody('uarm' + s, new THREE.SphereGeometry(0.058, 18, 14), skin);
      this.addBody('farm' + s, this.capsule(GEO.wrist, 0.037, 0.027), skin);
      this.addBody('farm' + s, this.ellipsoid(0.034, 0.055, 0.042), skin, T(0.0, -0.3, 0));
    }
  }

  // ---------------------------------------------------------------- per-frame update

  update(world: LifterWorld, dt = 1 / 60): void {
    const mb = world.mb;
    const F = this.frames;
    const st = this.style;
    F.pelvis.planar(mb.ox[B.pelvis], mb.oy[B.pelvis], mb.th[B.pelvis]);
    F.lumbar.planar(mb.ox[B.lumbar], mb.oy[B.lumbar], mb.th[B.lumbar]);
    F.thorax.planar(mb.ox[B.thorax], mb.oy[B.thorax], mb.th[B.thorax]);
    F.girdle.planar(mb.ox[B.girdle], mb.oy[B.girdle], mb.th[B.thorax]);
    const hp = TMP[0].set(0, 0, 0);
    F.thorax.point(0.02, 0.3, 0, hp);
    F.head.planar(hp.x, hp.y, mb.th[B.thorax] + 0.05);

    // Clean: the feet jump from hip width out to the receiving stance (a short hop), and stay there
    // for the recovery; they step back in while the bar is reset.
    const target = st.catchStance !== undefined ? this.catchTarget : 0;
    const prevBlend = this.catchBlend;
    this.catchBlend += Math.sign(target - this.catchBlend) * Math.min(Math.abs(target - this.catchBlend), dt / (target > this.catchBlend ? 0.14 : 0.35));
    const jumping = this.catchBlend > prevBlend && this.catchBlend < 1;
    this.hop = jumping ? 0.03 * Math.sin(Math.PI * this.catchBlend) : Math.max(0, this.hop - dt * 0.3);
    const cb = this.catchBlend * this.catchBlend * (3 - 2 * this.catchBlend);
    const stance = st.stance + ((st.catchStance ?? st.stance) - st.stance) * cb;
    const toeOut = st.toeOut + ((st.catchToe ?? st.toeOut) - st.toeOut) * cb;

    const hip3 = TMP[1],
      knee3 = TMP[2],
      ankle3 = TMP[3],
      fwd = TMP[4];
    const legFrac = GEO.thigh / (GEO.thigh + GEO.shank);
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      hip3.set(mb.ox[B.thigh], mb.oy[B.thigh], side * 0.09);
      ankle3.set(mb.ox[B.foot], mb.oy[B.foot] + this.hop, side * stance);
      // Knees track over the toes: on the hip–ankle line, pushed out along the turned-out foot as
      // far as the knee travels forward of the ankle.
      const kneeFwd = Math.max(0, mb.ox[B.shank] - mb.ox[B.foot]);
      knee3.set(mb.ox[B.shank], mb.oy[B.shank], side * (0.09 + (stance - 0.09) * legFrac + kneeFwd * Math.tan(toeOut)));
      fwd.set(Math.cos(mb.th[B.thigh]), Math.sin(mb.th[B.thigh]), 0);
      F['thigh' + s].limb(hip3, knee3, fwd);
      fwd.set(Math.cos(mb.th[B.shank]), Math.sin(mb.th[B.shank]), 0);
      F['shank' + s].limb(knee3, ankle3, fwd);
      const ff = F['foot' + s];
      ff.planar(ankle3.x, ankle3.y, mb.th[B.foot], ankle3.z);
      const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), side * toeOut);
      ff.x.applyQuaternion(rot);
      ff.z.applyQuaternion(rot);
      ff.sync();
    }

    const mode = world.barMode;
    if (mode === 'front' && this.prevMode !== 'front') {
      this.rackT = 0;
      this.turnFrom[0].copy(this.elbDir[0]);
      this.turnFrom[1].copy(this.elbDir[1]);
    }
    this.prevMode = mode;
    this.rackT += dt;
    const sh3 = TMP[5],
      hand3 = TMP[6],
      elb3 = TMP[7];
    const [bx, by] = world.barPos();
    const pe = [0, 0];
    mb.worldPoint(B.forearm, 0, 0, pe);
    const elbowBend = world.anat[7];
    const thTh = mb.th[B.thorax];
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      const k = side > 0 ? 0 : 1;
      sh3.set(mb.ox[B.girdle], mb.oy[B.girdle], side * 0.19);
      if (mode === 'free') {
        const g = [0, 0];
        mb.worldPoint(B.forearm, 0, -GEO.grip, g);
        hand3.set(g[0], g[1], side * 0.24);
      } else hand3.set(bx, by, side * st.gripHalf);
      const pole = new THREE.Vector3();
      if (mode === 'front') {
        // Front rack: elbows high and forward (upper arm about parallel to the floor), slightly
        // outside the shoulders, never caving in. The elbows sweep round the bar into it.
        const rack = new THREE.Vector3(0.985, -0.12, 0.13 * side).normalize();
        const u = Math.min(1, this.rackT / 0.25);
        const dir = this.turnFrom[k].clone().lerp(rack, u * u * (3 - 2 * u)).normalize();
        elb3.copy(sh3).addScaledVector(dir, GEO.upperArm);
        pole.copy(dir);
      } else {
        if (mode === 'back') pole.set(-0.4, -1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), thTh);
        else if (elbowBend > 0.35) {
          // Pulling under the bar: elbows high and wide, above the bar ("elbows up and out").
          pole.set(-0.15 * Math.cos(thTh), 0.55, 0);
        } else pole.set(pe[0] - sh3.x, pe[1] - sh3.y, 0);
        if (pole.lengthSq() < 1e-6) pole.set(-0.3, -1, 0);
        pole.normalize();
        pole.z += side * (mode === 'hands' && elbowBend > 0.35 ? 1.1 : 0.45);
        twoBoneIK(sh3, hand3, GEO.upperArm, GEO.grip, pole, elb3);
      }
      this.elbDir[k].subVectors(elb3, sh3).normalize();
      const ant = pole.clone().negate();
      F['uarm' + s].limb(sh3, elb3, ant);
      F['farm' + s].limb(elb3, hand3, ant);
    }

    for (const b of this.bodyMeshes) {
      b.mesh.matrix.multiplyMatrices(F[b.frame].m, b.local);
      b.mesh.matrixWorldNeedsUpdate = true;
    }
    this.updateMuscles(world);
  }

  private segFrame(seg: Seg, side: number): Frame {
    const F = this.frames;
    const s = side > 0 ? 'R' : 'L';
    switch (seg) {
      case 'thigh':
      case 'shank':
      case 'foot':
      case 'uarm':
      case 'farm':
        return F[seg + s];
      default:
        return F[seg];
    }
  }

  private updateMuscles(world: LifterWorld): void {
    const ms = world.muscles;
    const { pos, nor, act, ecc, tendon, glowSel, pathPts, samples } = this;
    const Tn = new THREE.Vector3(),
      W = new THREE.Vector3(),
      N = new THREE.Vector3(),
      lat = new THREE.Vector3();
    this.tubes.forEach((tube, ti) => {
      const { vis, side, offset } = tube;
      const np = vis.path.length;
      for (let i = 0; i < np; i++) {
        const [seg, x, y, z] = vis.path[i];
        this.segFrame(seg, side).point(x, y, z * side, pathPts[i]);
      }
      catmull(pathPts, np, samples);
      let len = 0;
      for (let i = 1; i < SAMPLES; i++) len += samples[i].distanceTo(samples[i - 1]);
      if (!this.initRest) this.restLen[ti] = len;
      const rest = this.restLen[ti] || len;
      let a = 0,
        e = 0,
        sel = 0;
      for (const [id, w] of vis.src) {
        const k = MI[id];
        a += ms.a[k] * w;
        const vt = ms.vt[k];
        if (vt > 0.03 && ms.a[k] > 0.08) e = Math.max(e, Math.min(1, (vt - 0.03) * 10) * w);
        sel = Math.max(sel, this.highlight[k] * w);
      }
      a = Math.min(1, a);
      const bulge = (1 + 0.2 * a) * Math.min(1.3, Math.max(0.78, Math.sqrt(rest / Math.max(1e-4, len))));
      const [u0, u1] = vis.belly ?? [0.1, 0.9];
      const rt0 = vis.rt ?? 0.8,
        rw0 = vis.rw ?? 1;
      const tr = vis.tendon ?? 0.006;
      lat.copy(this.segFrame(vis.path[0][0], side).z).multiplyScalar(side);
      for (let r = 0; r < RINGS; r++) {
        const u = r / (RINGS - 1);
        const p = samples[r];
        if (r === 0) Tn.subVectors(samples[1], samples[0]);
        else if (r === RINGS - 1) Tn.subVectors(samples[r], samples[r - 1]);
        else Tn.subVectors(samples[r + 1], samples[r - 1]);
        Tn.normalize();
        N.crossVectors(Tn, lat);
        if (N.lengthSq() < 1e-8) N.set(0, 0, 1).cross(Tn);
        N.normalize();
        W.crossVectors(N, Tn).normalize();
        const t = Math.max(0, Math.min(1, (u - u0) / (u1 - u0)));
        const bump = Math.pow(Math.sin(Math.PI * t), 0.6);
        const rad = tr + (vis.r * 1.12 - tr) * bump * bulge;
        const rw = rad * rw0,
          rtk = rad * rt0 * (0.9 + 0.1 * bulge);
        const tend = bump < 0.35 ? 1 - bump / 0.35 : 0;
        for (let k = 0; k < RADIAL; k++) {
          const ph = (k / RADIAL) * Math.PI * 2;
          const c = Math.cos(ph),
            sn = Math.sin(ph);
          const v = offset + r * RADIAL + k;
          pos[v * 3] = p.x + W.x * c * rw + N.x * sn * rtk;
          pos[v * 3 + 1] = p.y + W.y * c * rw + N.y * sn * rtk;
          pos[v * 3 + 2] = p.z + W.z * c * rw + N.z * sn * rtk;
          const nx = W.x * c * rtk + N.x * sn * rw,
            ny = W.y * c * rtk + N.y * sn * rw,
            nz = W.z * c * rtk + N.z * sn * rw;
          const il = 1 / Math.hypot(nx, ny, nz);
          nor[v * 3] = nx * il;
          nor[v * 3 + 1] = ny * il;
          nor[v * 3 + 2] = nz * il;
          act[v] = a;
          ecc[v] = e;
          tendon[v] = tend;
          glowSel[v] = sel;
        }
      }
    });
    this.initRest = true;
    const g = this.muscleGeo;
    for (const n of ['position', 'normal', 'act', 'ecc', 'tendon', 'sel']) (g.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
  }

  /** World position of a named point (for overlays). */
  jointWorld(name: 'hip' | 'knee' | 'ankle' | 'shoulder' | 'elbow' | 'lumbar' | 'head', out: THREE.Vector3, side = 1): THREE.Vector3 {
    const F = this.frames;
    const s = side > 0 ? 'R' : 'L';
    switch (name) {
      case 'hip':
        return out.copy(F['thigh' + s].o);
      case 'knee':
        return out.copy(F['shank' + s].o);
      case 'ankle':
        return out.copy(F['foot' + s].o);
      case 'shoulder':
        return out.copy(F['uarm' + s].o);
      case 'elbow':
        return out.copy(F['farm' + s].o);
      case 'lumbar':
        return out.copy(F.lumbar.o);
      case 'head':
        return F.head.point(0.01, 0.17, 0, out);
    }
  }
}

/** Two-bone IK: elbow position for root→target with lengths a, b, bending toward `pole`. */
function twoBoneIK(root: THREE.Vector3, target: THREE.Vector3, a: number, b: number, pole: THREE.Vector3, out: THREE.Vector3): void {
  const d = new THREE.Vector3().subVectors(target, root);
  let L = d.length();
  const minL = Math.abs(a - b) + 1e-3,
    maxL = a + b - 1e-4;
  const dir = d.clone().normalize();
  if (L < minL) L = minL;
  if (L > maxL) L = maxL;
  const cosA = (a * a + L * L - b * b) / (2 * a * L);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const perp = pole.clone().addScaledVector(dir, -pole.dot(dir));
  if (perp.lengthSq() < 1e-8) perp.set(0, -1, 0).addScaledVector(dir, dir.y);
  perp.normalize();
  out.copy(root).addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
}

/** Centripetal-ish Catmull–Rom through `n` control points, resampled uniformly by parameter. */
function catmull(pts: THREE.Vector3[], n: number, out: THREE.Vector3[]): void {
  const m = out.length;
  for (let i = 0; i < m; i++) {
    const f = (i / (m - 1)) * (n - 1);
    const k = Math.min(n - 2, Math.floor(f));
    const t = f - k;
    const p0 = pts[Math.max(0, k - 1)],
      p1 = pts[k],
      p2 = pts[k + 1],
      p3 = pts[Math.min(n - 1, k + 2)];
    const t2 = t * t,
      t3 = t2 * t;
    const o = out[i];
    o.x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
    o.y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
    o.z = 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
  }
}
