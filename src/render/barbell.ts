import * as THREE from 'three/webgpu';
import { color, float, fract, mix, sin, smoothstep, uv } from 'three/tsl';

interface PlateSpec {
  kg: number;
  r: number;
  t: number;
  col: number;
  text: string;
}

const PLATES: PlateSpec[] = [
  { kg: 25, r: 0.225, t: 0.066, col: 0xc62828, text: '#fff' },
  { kg: 20, r: 0.225, t: 0.056, col: 0x1565c0, text: '#fff' },
  { kg: 15, r: 0.225, t: 0.046, col: 0xf2b705, text: '#1b1b1b' },
  { kg: 10, r: 0.225, t: 0.036, col: 0x2e7d32, text: '#fff' },
  { kg: 5, r: 0.225, t: 0.028, col: 0xe8e8e8, text: '#1b1b1b' },
  { kg: 2.5, r: 0.095, t: 0.02, col: 0xb71c1c, text: '#fff' },
  { kg: 1.25, r: 0.08, t: 0.016, col: 0xb0b6be, text: '#1b1b1b' },
];

export function plateLoad(total: number): PlateSpec[] {
  let side = Math.max(0, (total - 20) / 2);
  const out: PlateSpec[] = [];
  for (const p of PLATES) {
    while (side >= p.kg - 1e-6 && out.length < 9) {
      out.push(p);
      side -= p.kg;
    }
  }
  return out;
}

/** Olympic barbell with IWF bumper plates, positioned from the simulation's bar state. */
export class BarbellView {
  readonly group = new THREE.Group();
  private readonly spin = new THREE.Group();
  private readonly plateGroup = new THREE.Group();
  private readonly faceCache = new Map<string, THREE.CanvasTexture>();
  private readonly steel: THREE.MeshStandardNodeMaterial;
  private readonly sleeveMat: THREE.MeshStandardMaterial;
  kg = 0;

  constructor() {
    this.group.add(this.spin);
    this.spin.add(this.plateGroup);
    this.steel = new THREE.MeshStandardNodeMaterial({ metalness: 1, roughness: 0.32 });
    const knurl = sin(uv().x.mul(628)).mul(sin(uv().y.mul(700))).abs();
    const v = uv().y;
    const knurlZone = smoothstep(0.06, 0.08, v).mul(smoothstep(0.94, 0.92, v)).mul(smoothstep(0.03, 0.05, fract(v).sub(0.5).abs()));
    this.steel.colorNode = mix(color(0xc9ced6), color(0x8a9099), knurl.mul(knurlZone).mul(0.6));
    this.steel.roughnessNode = float(0.28).add(knurl.mul(knurlZone).mul(0.35));
    this.sleeveMat = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, metalness: 1, roughness: 0.18 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0145, 0.0145, 1.31, 20), this.steel);
    shaft.rotation.x = Math.PI / 2;
    shaft.castShadow = true;
    this.spin.add(shaft);
    for (const s of [-1, 1]) {
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.03, 24), this.sleeveMat);
      collar.rotation.x = Math.PI / 2;
      collar.position.z = s * (0.655 + 0.015);
      this.spin.add(collar);
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.415, 24), this.sleeveMat);
      sleeve.rotation.x = Math.PI / 2;
      sleeve.position.z = s * (0.685 + 0.2075);
      sleeve.castShadow = true;
      this.spin.add(sleeve);
    }
  }

  private face(p: PlateSpec): THREE.CanvasTexture {
    const key = `${p.kg}`;
    const cached = this.faceCache.get(key);
    if (cached) return cached;
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const col = '#' + p.col.toString(16).padStart(6, '0');
    g.fillStyle = col;
    g.fillRect(0, 0, S, S);
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 3;
    for (const rr of [0.93, 0.62]) {
      g.beginPath();
      g.arc(S / 2, S / 2, (S / 2) * rr, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = p.text;
    g.font = `800 ${S * 0.16}px "Helvetica Neue", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`${p.kg}`, S / 2, S * 0.22);
    g.font = `700 ${S * 0.07}px "Helvetica Neue", sans-serif`;
    g.fillText('KG', S / 2, S * 0.33);
    g.fillText('MUSCLE LAB', S / 2, S * 0.8);
    g.fillStyle = '#c7ccd3';
    g.beginPath();
    g.arc(S / 2, S / 2, S * 0.12, 0, Math.PI * 2);
    g.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.faceCache.set(key, tex);
    return tex;
  }

  setWeight(kg: number): void {
    if (kg === this.kg) return;
    this.kg = kg;
    this.plateGroup.clear();
    const plates = plateLoad(kg);
    for (const s of [-1, 1]) {
      let z = 0.685 + 0.004;
      for (const p of plates) {
        const side = new THREE.MeshStandardMaterial({ color: p.col, roughness: 0.78, metalness: 0.02 });
        const faceMat = new THREE.MeshStandardMaterial({ map: this.face(p), roughness: 0.7 });
        const geo = new THREE.CylinderGeometry(p.r, p.r, p.t, 48, 1);
        const mesh = new THREE.Mesh(geo, [side, faceMat, faceMat]);
        mesh.rotation.x = (s * Math.PI) / 2;
        mesh.position.z = s * (z + p.t / 2);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.plateGroup.add(mesh);
        z += p.t + 0.002;
      }
      const clamp = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.035, 20), new THREE.MeshStandardMaterial({ color: 0x222228, roughness: 0.4, metalness: 0.3 }));
      clamp.rotation.x = Math.PI / 2;
      clamp.position.z = s * (z + 0.02);
      this.plateGroup.add(clamp);
    }
  }

  update(x: number, y: number, theta: number): void {
    this.group.position.set(x, y, 0);
    this.spin.rotation.z = theta;
  }
}

