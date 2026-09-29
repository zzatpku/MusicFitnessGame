import * as THREE from 'three/webgpu';
import { attribute, color, float, mrt, uniform } from 'three/tsl';
import { B, JI } from '../sim/body.ts';
import type { LifterWorld } from '../sim/world.ts';
import type { LifterView } from './lifter.ts';

const TRAIL_MAX = 400;

interface Arc {
  joint: number;
  name: 'hip' | 'knee' | 'ankle' | 'lumbar' | 'shoulder' | 'elbow';
  max: number;
  r: number;
  mesh: THREE.Mesh;
  pos: Float32Array;
  tint: THREE.Vector3;
}

const SEG = 40;

/** Biomechanics overlays: COM, centre of pressure + ground reaction force, bar path, joint torque arcs. */
export class Overlays {
  readonly group = new THREE.Group();
  visible = { com: true, grf: true, path: true, torque: true };
  private readonly comDot: THREE.Mesh;
  private readonly comLine: THREE.Mesh;
  private readonly comRing: THREE.Mesh;
  private readonly copDisc: THREE.Mesh;
  private readonly grf = new THREE.Group();
  private readonly support: THREE.Mesh;
  private readonly supportTint = new THREE.Vector3(0.18, 0.9, 0.65);
  private readonly trailGeo = new THREE.BufferGeometry();
  private readonly trailPos = new Float32Array(TRAIL_MAX * 2 * 3);
  private readonly trailCol = new Float32Array(TRAIL_MAX * 2 * 3);
  private readonly trail: THREE.Mesh;
  private readonly arcs: Arc[] = [];
  private readonly tmp = new THREE.Vector3();

  constructor() {
    const glow = (hex: number, k = 1.6) => {
      const m = new THREE.MeshBasicNodeMaterial();
      m.colorNode = color(hex);
      m.mrtNode = mrt({ emissive: color(hex).mul(k) });
      return m;
    };
    this.comDot = new THREE.Mesh(new THREE.SphereGeometry(0.024, 16, 12), glow(0xffd54a, 2.2));
    this.comLine = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 1, 6), glow(0xffd54a, 0.9));
    const ringMat = glow(0xffd54a, 1.2);
    ringMat.transparent = true;
    ringMat.opacity = 0.8;
    this.comRing = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.045, 32), ringMat);
    this.comRing.rotation.x = -Math.PI / 2;
    const copMat = glow(0x2ee6a6, 1.4);
    copMat.transparent = true;
    copMat.opacity = 0.9;
    this.copDisc = new THREE.Mesh(new THREE.CircleGeometry(0.03, 24), copMat);
    this.copDisc.rotation.x = -Math.PI / 2;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 8), glow(0x2ee6a6, 1.3));
    shaft.position.y = 0.5;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.07, 12), glow(0x2ee6a6, 1.6));
    head.position.y = 1.035;
    this.grf.add(shaft, head);

    const supMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    supMat.colorNode = uniform(this.supportTint);
    supMat.opacityNode = float(0.22);
    this.support = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.42), supMat);
    this.support.rotation.x = -Math.PI / 2;
    this.support.renderOrder = 2;

    const idx: number[] = [];
    for (let i = 0; i < TRAIL_MAX - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.trailGeo.setAttribute('color', new THREE.BufferAttribute(this.trailCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.trailGeo.setIndex(idx);
    this.trailGeo.setDrawRange(0, 0);
    const trailMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
    const vc = attribute<'vec3'>('color', 'vec3');
    trailMat.colorNode = vc;
    trailMat.mrtNode = mrt({ emissive: vc.mul(1.4) });
    trailMat.opacityNode = float(0.95);
    this.trail = new THREE.Mesh(this.trailGeo, trailMat);
    this.trail.frustumCulled = false;

    const defs: [Arc['name'], number, number, number][] = [
      ['hip', JI.hip, 900, 0.095],
      ['knee', JI.knee, 700, 0.08],
      ['ankle', JI.ankle, 450, 0.065],
      ['lumbar', JI.lumbar, 650, 0.085],
      ['shoulder', JI.shoulder, 160, 0.07],
      ['elbow', JI.elbow, 150, 0.055],
    ];
    for (const [name, joint, max, r] of defs) {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array((SEG + 1) * 2 * 3);
      const ix: number[] = [];
      for (let i = 0; i < SEG; i++) {
        const a = i * 2;
        ix.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setIndex(ix);
      const tint = new THREE.Vector3(1, 0.48, 0.18);
      const tu = uniform(tint);
      const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
      mat.colorNode = tu;
      mat.mrtNode = mrt({ emissive: tu.mul(1.8) });
      mat.opacityNode = float(0.92);
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      this.arcs.push({ joint, name, max, r, mesh, pos, tint });
      this.group.add(mesh);
    }
    this.group.add(this.comDot, this.comLine, this.comRing, this.copDisc, this.grf, this.support, this.trail);
  }

  update(world: LifterWorld, lifter: LifterView, trail: [number, number, number][]): void {
    const v = this.visible;
    const [cx, cy] = world.com(true);
    this.comDot.visible = this.comLine.visible = this.comRing.visible = v.com;
    this.comDot.position.set(cx, cy, 0);
    this.comLine.position.set(cx, cy / 2, 0);
    this.comLine.scale.y = Math.max(0.01, cy);
    this.comRing.position.set(cx, 0.004, 0);

    const [heel, toe] = world.footEdges();
    this.support.visible = v.grf;
    this.support.position.set((heel + toe) / 2, 0.003, 0);
    this.support.scale.x = Math.max(0.05, toe - heel);
    const rel = world.grfY > 20 ? (world.copX - heel) / (toe - heel) : 0.5;
    const edge = Math.min(1, Math.max(0, (Math.abs(rel - 0.5) - 0.25) / 0.2));
    this.supportTint.set(0.18 + 0.82 * edge, 0.9 - 0.55 * edge, 0.65 - 0.5 * edge);

    const grfOn = v.grf && world.grfY > 20;
    this.copDisc.visible = this.grf.visible = grfOn;
    if (grfOn) {
      this.copDisc.position.set(world.copX, 0.005, 0);
      this.grf.position.set(world.copX, 0.005, 0);
      const len = Math.min(1.6, Math.hypot(world.grfX, world.grfY) / 2000);
      this.grf.scale.set(1, len, 1);
      this.grf.rotation.z = Math.atan2(-world.grfX, world.grfY);
    }

    this.trail.visible = v.path;
    const n = Math.min(TRAIL_MAX, trail.length);
    const z = 0.965;
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const [x, y, sp] = trail[trail.length - n + i];
      const prev = trail[Math.max(0, trail.length - n + i - 1)];
      const next = trail[Math.min(trail.length - 1, trail.length - n + i + 1)];
      let dx = next[0] - prev[0],
        dy = next[1] - prev[1];
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl;
      dy /= dl;
      const w = 0.007;
      const a = i * 6;
      this.trailPos[a] = x - dy * w;
      this.trailPos[a + 1] = y + dx * w;
      this.trailPos[a + 2] = z;
      this.trailPos[a + 3] = x + dy * w;
      this.trailPos[a + 4] = y - dx * w;
      this.trailPos[a + 5] = z;
      c.setHSL(0.6 - Math.min(1, sp / 1.6) * 0.55, 0.95, 0.55);
      const fade = 0.25 + 0.75 * (i / Math.max(1, n - 1));
      for (const o of [0, 3]) {
        this.trailCol[a + o] = c.r * fade;
        this.trailCol[a + o + 1] = c.g * fade;
        this.trailCol[a + o + 2] = c.b * fade;
      }
    }
    this.trailGeo.setDrawRange(0, Math.max(0, (n - 1) * 6));
    (this.trailGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.trailGeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;

    const mb = world.mb;
    for (const arc of this.arcs) {
      arc.mesh.visible = v.torque;
      if (!v.torque) continue;
      const tau = world.tauJoint[arc.joint];
      const frac = Math.min(1, Math.abs(tau) / arc.max);
      lifter.jointWorld(arc.name, this.tmp, 1);
      const o = this.tmp;
      o.z += 0.13;
      let base = 0;
      if (arc.name === 'hip') base = mb.th[B.thigh] - Math.PI / 2;
      else if (arc.name === 'knee') base = mb.th[B.shank] - Math.PI / 2;
      else if (arc.name === 'ankle') base = mb.th[B.foot];
      else if (arc.name === 'lumbar') base = mb.th[B.lumbar] + Math.PI / 2;
      else if (arc.name === 'shoulder') base = mb.th[B.upperarm] - Math.PI / 2;
      else base = mb.th[B.forearm] - Math.PI / 2;
      const span = frac * Math.PI * 1.6 * (tau >= 0 ? 1 : -1);
      const w = 0.011 + 0.01 * frac;
      for (let i = 0; i <= SEG; i++) {
        const a = base + (span * i) / SEG;
        const cs = Math.cos(a),
          sn = Math.sin(a);
        const k = i * 6;
        arc.pos[k] = o.x + cs * (arc.r - w);
        arc.pos[k + 1] = o.y + sn * (arc.r - w);
        arc.pos[k + 2] = o.z;
        arc.pos[k + 3] = o.x + cs * (arc.r + w);
        arc.pos[k + 4] = o.y + sn * (arc.r + w);
        arc.pos[k + 5] = o.z;
      }
      (arc.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      const k = 0.35 + 0.65 * frac;
      if (tau < 0) arc.tint.set(1 * k, 0.48 * k, 0.18 * k);
      else arc.tint.set(0.23 * k, 0.84 * k, 1 * k);
    }
  }
}

