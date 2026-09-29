import * as THREE from 'three/webgpu';
import { color, emissive, float, floor, fract, hash, mix, mrt, output, pass, positionWorld, sin, smoothstep, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type CameraPreset = 'orbit' | 'side' | 'front' | 'back';

/** Renderer (WebGPU → Metal on Apple Silicon, WebGL2 fallback), lights, gym environment, bloom. */
export class Stage {
  renderer!: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(36, 1, 0.05, 80);
  controls!: OrbitControls;
  pipeline!: THREE.RenderPipeline;
  backend = 'WebGL2';
  readonly rack = new THREE.Group();
  readonly bloomStrength = uniform(0.75);
  private readonly pinMeshes: THREE.Mesh[] = [];
  private camAnim: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;

  async init(container: HTMLElement): Promise<void> {
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);
    await renderer.init();
    this.renderer = renderer;
    const backend = (renderer as unknown as { backend: { isWebGPUBackend?: boolean } }).backend;
    this.backend = backend?.isWebGPUBackend ? 'WebGPU (Metal)' : 'WebGL2';

    this.scene.background = new THREE.Color(0x07090d);
    this.scene.fog = new THREE.Fog(0x07090d, 9, 26);

    this.camera.position.set(3.3, 1.35, 3.9);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.target.set(0.02, 0.86, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.4;
    this.controls.maxDistance = 9;
    this.controls.maxPolarAngle = Math.PI * 0.52;
    this.controls.update();

    this.buildLights();
    this.buildGym();
    this.buildRack();

    const scenePass = pass(this.scene, this.camera);
    scenePass.setMRT(mrt({ output, emissive }));
    const out = scenePass.getTextureNode('output');
    const emi = scenePass.getTextureNode('emissive');
    const glow = bloom(emi, 1.0, 0.45, 0.0);
    glow.strength = this.bloomStrength;
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputNode = out.add(glow);

    this.onResize = () => {
      const w = container.clientWidth,
        h = container.clientHeight;
      renderer.setSize(w, h);
      this.camera.aspect = w / h;
      // Centre the lifter in the space between the note highway (left) and the side panel (right).
      const side = w <= 1440 ? 252 : 302;
      const shift = (this.leftPx - side) / 2;
      if (Math.abs(shift) > 1) this.camera.setViewOffset(w, h, -shift, 0, w, h);
      else this.camera.clearViewOffset();
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  private leftPx = 0;
  private onResize: () => void = () => {};

  /** Width (px) covered by UI on the left; the view is shifted so the lifter stays centred in the free area. */
  setViewShift(leftPx: number): void {
    this.leftPx = leftPx + 12;
    this.onResize();
  }

  private buildLights(): void {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0x9fb8ff, 0x1a130d, 0.55));
    const key = new THREE.DirectionalLight(0xfff3e6, 2.6);
    key.position.set(3.2, 6.5, 4.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -2.5;
    key.shadow.camera.right = 2.5;
    key.shadow.camera.top = 3;
    key.shadow.camera.bottom = -1;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 16;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    s.add(key);
    const rim = new THREE.DirectionalLight(0x6fa8ff, 1.6);
    rim.position.set(-4, 3.5, -3.5);
    s.add(rim);
    const fill = new THREE.DirectionalLight(0xffa36b, 0.55);
    fill.position.set(-2.5, 1.5, 4);
    s.add(fill);
    const spot = new THREE.SpotLight(0xffffff, 28, 9, Math.PI / 6, 0.5, 1.6);
    spot.position.set(0.3, 5.2, 0.8);
    spot.target.position.set(0, 0.8, 0);
    s.add(spot, spot.target);
  }

  private buildGym(): void {
    const s = this.scene;
    // Rubber gym floor with subtle tile seams.
    const floorMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0.0 });
    const f = fract(positionWorld.xz);
    const seam = smoothstep(0.0, 0.02, f.x).mul(smoothstep(0.0, 0.02, f.y)).mul(smoothstep(1.0, 0.98, f.x)).mul(smoothstep(1.0, 0.98, f.y));
    const tileTone = hash(floor(positionWorld.xz)).mul(0.012);
    floorMat.colorNode = mix(color(0x060607), color(0x111215), seam).add(tileTone);
    const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -0.024;
    floorMesh.receiveShadow = true;
    s.add(floorMesh);

    // Olympic lifting platform: wooden centre, black rubber sides.
    const wood = new THREE.MeshStandardNodeMaterial({ roughness: 0.62, metalness: 0.0 });
    const p = positionWorld;
    const plank = floor(p.z.mul(6.5));
    const ring = sin(p.x.mul(9).add(sin(p.z.mul(5).add(plank.mul(1.7))).mul(1.4)).add(hash(plank).mul(20))).mul(0.5).add(0.5);
    const grain = sin(p.x.mul(38).add(p.z.mul(4)).add(hash(plank).mul(9))).mul(0.5).add(0.5);
    const woodBase = mix(color(0x6f4a2a), color(0x98683b), ring.mul(0.6).add(grain.mul(0.12)));
    const seamZ = smoothstep(0.0, 0.01, fract(p.z.mul(6.5))).mul(0.25).add(0.75);
    wood.colorNode = woodBase.mul(seamZ).mul(mix(float(0.86), float(1.04), hash(plank)));
    const platform = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.024, 2.44), wood);
    platform.position.set(0.05, -0.012, 0);
    platform.receiveShadow = true;
    s.add(platform);
    const rubber = new THREE.MeshStandardMaterial({ color: 0x151516, roughness: 0.95 });
    for (const sx of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.024, 2.44), rubber);
      side.position.set(0.05 + sx * (0.675 + 0.41), -0.012, 0);
      side.receiveShadow = true;
      s.add(side);
    }
    const trim = new THREE.MeshStandardNodeMaterial({ roughness: 0.4 });
    trim.colorNode = color(0x1d2230);
    trim.emissiveNode = color(0x2f7bff).mul(0.35);
    for (const sz of [-1, 1]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.006, 0.012), trim);
      t.position.set(0.05, 0.002, sz * 1.225);
      s.add(t);
    }

    // Back wall with neon strips and a big wordmark.
    const wallMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
    const wy = positionWorld.y;
    wallMat.colorNode = mix(color(0x0a0c12), color(0x141925), smoothstep(0.0, 4.0, wy));
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(26, 9), wallMat);
    wall.position.set(0, 4.5, -5.5);
    s.add(wall);
    const neon = (col: number, w: number, h: number, x: number, y: number, z: number, glow = 2.2) => {
      const m = new THREE.MeshBasicNodeMaterial();
      m.colorNode = color(col);
      m.mrtNode = mrt({ emissive: color(col).mul(glow) });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
      mesh.position.set(x, y, z);
      s.add(mesh);
      return mesh;
    };
    neon(0x2f7bff, 14, 0.035, 0, 3.4, -5.48);
    neon(0xff5a1f, 14, 0.02, 0, 3.25, -5.48, 1.6);
    neon(0x2f7bff, 14, 0.02, 0, 0.35, -5.48, 1.2);
    const label = this.makeLabel('MUSCLE LAB · 肌动实验室', 2048, 256);
    const labelMat = new THREE.MeshBasicMaterial({ map: label, transparent: true, depthWrite: false });
    const lm = new THREE.Mesh(new THREE.PlaneGeometry(7, 0.875), labelMat);
    lm.position.set(0, 4.3, -5.47);
    s.add(lm);

    // Equipment silhouettes: plate trees and a dumbbell rack along the wall.
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: 0.6, metalness: 0.4 });
    const plateCols = [0xc62828, 0x1565c0, 0xf9a825, 0x2e7d32];
    for (const [px, pz] of [
      [-3.3, -3.2],
      [3.4, -3.0],
    ]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.3, 12), dark);
      post.position.set(px, 0.65, pz);
      s.add(post);
      plateCols.forEach((c, i) => {
        const pm = new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 });
        const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.225, 0.225, 0.06, 40), pm);
        plate.rotation.z = Math.PI / 2;
        plate.position.set(px + (i % 2 ? 0.12 : -0.12), 0.26 + Math.floor(i / 2) * 0.5, pz);
        plate.castShadow = true;
        s.add(plate);
      });
    }
    const dbRack = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.06, 0.5), dark);
    dbRack.position.set(0, 0.75, -4.7);
    s.add(dbRack);
    for (let i = 0; i < 10; i++) {
      const g = new THREE.Group();
      const hd = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.5 });
      const r = 0.06 + i * 0.004;
      for (const sx of [-1, 1]) {
        const head = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.07, 6), hd);
        head.rotation.x = Math.PI / 2;
        head.position.z = sx * 0.13;
        g.add(head);
      }
      g.position.set(-1.45 + i * 0.32, 0.84, -4.7);
      s.add(g);
    }
  }

  /** Half rack behind the lifter (keeps the view clear) with safety arms reaching forward under the bar. */
  private buildRack(): void {
    const steel = new THREE.MeshStandardMaterial({ color: 0x23262d, roughness: 0.35, metalness: 0.85 });
    const accent = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.6 });
    accent.colorNode = color(0xd84315);
    const X = -0.62;
    for (const z of [-0.66, 0.66]) {
      const u = new THREE.Mesh(new THREE.BoxGeometry(0.075, 2.25, 0.075), steel);
      u.position.set(X, 1.125, z);
      u.castShadow = true;
      this.rack.add(u);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.075), steel);
      foot.position.set(X - 0.1, 0.025, z);
      this.rack.add(foot);
      const hook = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.06), accent);
      hook.position.set(X + 0.08, 1.42, z);
      this.rack.add(hook);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 1.4), steel);
    top.position.set(X, 2.22, 0);
    this.rack.add(top);
    for (const z of [-0.6, 0.6]) {
      const pin = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.036, 0.05), accent);
      pin.castShadow = true;
      pin.position.set(X + 0.55, 0.9, z);
      this.pinMeshes.push(pin);
      this.rack.add(pin);
    }
    this.rack.visible = false;
    this.scene.add(this.rack);
  }

  /** Show the squat rack with its safety pins at the given bar-centre height (null hides it). */
  setRack(pinBarY: number | null): void {
    this.rack.visible = pinBarY !== null;
    if (pinBarY !== null) for (const p of this.pinMeshes) p.position.y = pinBarY - 0.018;
  }

  setCamera(preset: CameraPreset): void {
    const target = new THREE.Vector3(0.02, 0.86, 0);
    const pos: Record<CameraPreset, [number, number, number]> = {
      orbit: [3.3, 1.35, 3.9],
      side: [1.0, 1.3, 4.9],
      front: [4.6, 1.25, 1.2],
      back: [-3.6, 1.55, 2.8],
    };
    this.controls.target.copy(target);
    this.camAnim = { from: this.camera.position.clone(), to: new THREE.Vector3(...pos[preset]), t: 0 };
  }

  update(dt: number): void {
    if (this.camAnim) {
      const a = this.camAnim;
      a.t = Math.min(1, a.t + dt * 2.2);
      const k = a.t * a.t * (3 - 2 * a.t);
      this.camera.position.lerpVectors(a.from, a.to, k);
      if (a.t >= 1) this.camAnim = null;
    }
    this.controls.update();
  }

  render(): void {
    this.pipeline.render();
  }

  makeLabel(text: string, w: number, h: number): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    g.font = `800 ${Math.floor(h * 0.52)}px "PingFang SC", "Helvetica Neue", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(47,123,255,0.9)';
    g.shadowBlur = h * 0.12;
    g.fillStyle = '#dfe8ff';
    g.fillText(text, w / 2, h / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
}

