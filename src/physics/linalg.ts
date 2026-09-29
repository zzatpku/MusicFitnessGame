/** Small dense linear algebra helpers (row-major, n×n). Sized for ~10–20 DOF systems. */

export function cholesky(A: Float64Array, L: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) {
    const ri = i * n;
    for (let j = 0; j <= i; j++) {
      const rj = j * n;
      let s = A[ri + j];
      for (let k = 0; k < j; k++) s -= L[ri + k] * L[rj + k];
      if (i === j) L[ri + i] = Math.sqrt(s > 1e-12 ? s : 1e-12);
      else L[ri + j] = s / L[rj + j];
    }
    for (let j = i + 1; j < n; j++) L[ri + j] = 0;
  }
}

/** Solve (L Lᵀ) x = b. `x` may alias `b`. */
export function cholSolve(L: Float64Array, n: number, b: Float64Array, x: Float64Array): void {
  for (let i = 0; i < n; i++) {
    let s = b[i];
    const ri = i * n;
    for (let k = 0; k < i; k++) s -= L[ri + k] * x[k];
    x[i] = s / L[ri + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
}

export function dot(a: Float64Array, b: Float64Array, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const DEG = Math.PI / 180;
