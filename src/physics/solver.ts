import { cholSolve } from './linalg.ts';

/**
 * A velocity-level constraint row:  J·v⁺ = bias (bilateral)  or  J·v⁺ ≥ bias with λ ≥ 0 (unilateral).
 * Friction rows reference a normal row and are bounded by |λ| ≤ μ λₙ.
 */
export class Row {
  readonly J: Float64Array;
  readonly W: Float64Array;
  lo = 0;
  hi = Infinity;
  bias = 0;
  normal = -1;
  mu = 0;
  lambda = 0;
  key = 0;
  cfm = 0;
  diag = 1;

  constructor(n: number) {
    this.J = new Float64Array(n);
    this.W = new Float64Array(n);
  }
}

export class RowPool {
  readonly rows: Row[] = [];
  count = 0;
  private readonly n: number;
  constructor(n: number) {
    this.n = n;
  }

  reset(): void {
    this.count = 0;
  }

  alloc(key: number): Row {
    if (this.count >= this.rows.length) this.rows.push(new Row(this.n));
    const r = this.rows[this.count++];
    r.J.fill(0);
    r.lo = 0;
    r.hi = Infinity;
    r.bias = 0;
    r.normal = -1;
    r.mu = 0;
    r.lambda = 0;
    r.key = key;
    r.cfm = 0;
    return r;
  }

  /** Index of the most recently allocated row. */
  last(): number {
    return this.count - 1;
  }
}

/**
 * Projected Gauss–Seidel on the Delassus operator J M⁻¹ Jᵀ, with warm starting.
 * `L` is the Cholesky factor of the (effective) mass matrix; `v` is updated in place.
 */
export function solvePGS(
  pool: RowPool,
  L: Float64Array,
  n: number,
  v: Float64Array,
  iterations: number,
  warm: Map<number, number>,
): void {
  const rows = pool.rows;
  const m = pool.count;
  for (let r = 0; r < m; r++) {
    const row = rows[r];
    cholSolve(L, n, row.J, row.W);
    let d = row.cfm;
    for (let i = 0; i < n; i++) d += row.J[i] * row.W[i];
    row.diag = d > 1e-12 ? d : 1e-12;
    row.lambda = warm.get(row.key) ?? 0;
  }
  for (let r = 0; r < m; r++) {
    const row = rows[r];
    let lo = row.lo,
      hi = row.hi;
    if (row.normal >= 0) {
      hi = row.mu * rows[row.normal].lambda;
      lo = -hi;
    }
    row.lambda = row.lambda < lo ? lo : row.lambda > hi ? hi : row.lambda;
    if (row.lambda !== 0) {
      const W = row.W,
        l = row.lambda;
      for (let i = 0; i < n; i++) v[i] += W[i] * l;
    }
  }
  for (let it = 0; it < iterations; it++) {
    for (let r = 0; r < m; r++) {
      const row = rows[r];
      let lo = row.lo,
        hi = row.hi;
      if (row.normal >= 0) {
        hi = row.mu * rows[row.normal].lambda;
        lo = -hi;
      }
      const J = row.J;
      let jv = 0;
      for (let i = 0; i < n; i++) jv += J[i] * v[i];
      let nl = row.lambda + (row.bias - jv - row.cfm * row.lambda) / row.diag;
      nl = nl < lo ? lo : nl > hi ? hi : nl;
      const dl = nl - row.lambda;
      if (dl !== 0) {
        const W = row.W;
        for (let i = 0; i < n; i++) v[i] += W[i] * dl;
        row.lambda = nl;
      }
    }
  }
  warm.clear();
  for (let r = 0; r < m; r++) warm.set(rows[r].key, rows[r].lambda);
}
