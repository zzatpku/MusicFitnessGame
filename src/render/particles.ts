import * as THREE from 'three/webgpu';
import { Fn, If, color, float, hash, instanceIndex, instancedArray, mix, mrt, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl';

const COUNT = 6144;

/**
 * GPU (compute-shader) particle system for chalk dust and plate-impact puffs.
 * Spawning and integration both run as TSL compute kernels.
 */
export class DustParticles {
  readonly sprite: THREE.Sprite;
  private readonly updateKernel: THREE.ComputeNode;
  private readonly spawnKernel: THREE.ComputeNode;
  private readonly uDt = uniform(0.016);
  private readonly uCenter = uniform(new THREE.Vector3());
  private readonly uSpread = uniform(new THREE.Vector3(0.05, 0.02, 0.05));
  private readonly uSpeed = uniform(0.6);
  private readonly uStart = uniform(0);
  private readonly uCount = uniform(0);
  private readonly uSeed = uniform(0);
  private readonly tintVec = new THREE.Vector3(1, 1, 1);
  private readonly uTint = uniform(this.tintVec);
  private cursor = 0;
  private pending: { center: THREE.Vector3; spread: THREE.Vector3; speed: number; n: number; tint: number }[] = [];
  enabled = true;

  constructor() {
    const pos = instancedArray(COUNT, 'vec3');
    const vel = instancedArray(COUNT, 'vec3');
    const life = instancedArray(COUNT, 'float');
    const tint = instancedArray(COUNT, 'vec3');

    this.updateKernel = Fn(() => {
      const p = pos.element(instanceIndex);
      const v = vel.element(instanceIndex);
      const l = life.element(instanceIndex);
      If(l.greaterThan(0), () => {
        const dt = this.uDt;
        v.addAssign(vec3(0, -0.35, 0).mul(dt));
        v.mulAssign(float(1).sub(dt.mul(1.6)));
        p.addAssign(v.mul(dt));
        If(p.y.lessThan(0.002), () => {
          p.y.assign(0.002);
          v.mulAssign(vec3(0.4, -0.2, 0.4));
        });
        l.subAssign(dt.mul(0.45));
      });
    })().compute(COUNT);

    this.spawnKernel = Fn(() => {
      const rel = instanceIndex.toFloat().sub(this.uStart).add(COUNT).mod(COUNT);
      If(rel.lessThan(this.uCount), () => {
        const i = instanceIndex.toFloat().add(this.uSeed);
        const r1 = hash(i.mul(1.13)),
          r2 = hash(i.mul(2.71).add(7.3)),
          r3 = hash(i.mul(5.37).add(1.9)),
          r4 = hash(i.mul(9.11).add(3.3));
        const dir = vec3(r1.sub(0.5), r2.mul(0.8).add(0.2), r3.sub(0.5)).normalize();
        pos.element(instanceIndex).assign(this.uCenter.add(vec3(r2.sub(0.5), r3.sub(0.5), r1.sub(0.5)).mul(this.uSpread)));
        vel.element(instanceIndex).assign(dir.mul(this.uSpeed.mul(r4.mul(0.8).add(0.3))));
        life.element(instanceIndex).assign(r4.mul(0.5).add(0.6));
        tint.element(instanceIndex).assign(this.uTint);
      });
    })().compute(COUNT);

    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const l = life.toAttribute();
    const d = uv().sub(0.5).length();
    const soft = smoothstep(0.5, 0.0, d);
    const alive = smoothstep(0.0, 0.25, l);
    mat.positionNode = pos.toAttribute();
    mat.scaleNode = mix(float(0.05), float(0.012), l.saturate()).mul(alive.add(0.2));
    const tc = tint.toAttribute();
    mat.colorNode = vec4(mix(color(0xffffff), tc, 0.4), soft.mul(alive).mul(0.35));
    mat.mrtNode = mrt({ emissive: tc.mul(soft.mul(alive).mul(0.25)) });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.count = COUNT;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 5;
  }

  burst(center: THREE.Vector3, n: number, opts: { spread?: [number, number, number]; speed?: number; tint?: number } = {}): void {
    if (!this.enabled) return;
    this.pending.push({
      center: center.clone(),
      spread: new THREE.Vector3(...(opts.spread ?? [0.06, 0.03, 0.06])),
      speed: opts.speed ?? 0.6,
      n: Math.min(n, COUNT),
      tint: opts.tint ?? 0xffffff,
    });
  }

  update(renderer: THREE.WebGPURenderer, dt: number): void {
    if (!this.enabled) return;
    for (const p of this.pending) {
      this.uCenter.value.copy(p.center);
      this.uSpread.value.copy(p.spread);
      this.uSpeed.value = p.speed;
      this.uStart.value = this.cursor;
      this.uCount.value = p.n;
      this.uSeed.value = Math.random() * 1000;
      const c = new THREE.Color(p.tint);
      this.tintVec.set(c.r, c.g, c.b);
      renderer.compute(this.spawnKernel);
      this.cursor = (this.cursor + p.n) % COUNT;
    }
    this.pending.length = 0;
    this.uDt.value = Math.min(0.05, dt);
    renderer.compute(this.updateKernel);
  }
}
