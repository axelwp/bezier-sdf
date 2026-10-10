/**
 * Tapered quadratic Bezier "branches" — the primitive for the live
 * (non-baked) branch renderer.
 *
 * A branch is a single quadratic Bezier `P0 → P1 → P2` swept by a disc
 * whose radius tapers linearly in curve parameter from `r0` at `P0` to
 * `r1` at `P2`. `growth ∈ [0, 1]` clips the curve to its first `growth`
 * of parameter range, so a branch can be "grown" from its base by
 * animating one number.
 *
 * Everything here is plain TypeScript and mirrors the GLSL in
 * `shaders/branch.ts` line for line, so the closed-form distance can be
 * unit-tested on the CPU and used for hit-testing.
 */

export type Vec2 = readonly [number, number];

export interface TaperedBranch {
  /** Curve start (the branch base). */
  readonly p0: Vec2;
  /** Quadratic control point. */
  readonly p1: Vec2;
  /** Curve end (the branch tip when fully grown). */
  readonly p2: Vec2;
  /** Radius (half-width) at `p0`. */
  readonly r0: number;
  /** Radius (half-width) at `p2`. */
  readonly r1: number;
  /**
   * Fraction of the curve drawn, by Bezier parameter, measured from
   * `p0`. `0` hides the branch, `1` (the default) draws all of it.
   * Values outside `[0, 1]` are clamped.
   */
  readonly growth?: number;
}

/** Floats per branch in the packed instance buffer. */
export const BRANCH_STRIDE = 9;

/**
 * Pack branches into the flat instance layout the renderer uploads:
 * `[p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, r0, r1, growth]` per branch.
 *
 * Pass `out` to reuse a buffer across frames; it is returned as-is when
 * large enough, otherwise a new one is allocated.
 */
export function packBranches(
  branches: readonly TaperedBranch[],
  out?: Float32Array,
): Float32Array {
  const need = branches.length * BRANCH_STRIDE;
  const buf = out && out.length >= need ? out : new Float32Array(need);
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i]!;
    const o = i * BRANCH_STRIDE;
    buf[o] = b.p0[0];
    buf[o + 1] = b.p0[1];
    buf[o + 2] = b.p1[0];
    buf[o + 3] = b.p1[1];
    buf[o + 4] = b.p2[0];
    buf[o + 5] = b.p2[1];
    buf[o + 6] = b.r0;
    buf[o + 7] = b.r1;
    buf[o + 8] = b.growth ?? 1;
  }
  return buf;
}

/**
 * The visible part of a branch after growth clipping, as a new quadratic
 * with its own end radii. Splitting a quadratic at `g` by de Casteljau
 * gives an exact quadratic for `[0, g]`, so the closed-form distance
 * still applies to the clipped piece. The tip radius is the original
 * taper evaluated at `g`, so a growing branch keeps its final profile.
 */
export function clipBranch(b: TaperedBranch): {
  p0: Vec2; p1: Vec2; p2: Vec2; r0: number; r1: number;
} {
  const g = Math.min(1, Math.max(0, b.growth ?? 1));
  const q1: Vec2 = [lerp(b.p0[0], b.p1[0], g), lerp(b.p0[1], b.p1[1], g)];
  const q2: Vec2 = [
    lerp(q1[0], lerp(b.p1[0], b.p2[0], g), g),
    lerp(q1[1], lerp(b.p1[1], b.p2[1], g), g),
  ];
  return { p0: b.p0, p1: q1, p2: q2, r0: b.r0, r1: lerp(b.r0, b.r1, g) };
}

/**
 * Closed-form unsigned distance from `p` to the quadratic Bezier
 * `A → B → C`, plus the curve parameter of the closest point. Solves the
 * cubic `dot(B(t) - p, B'(t)) = 0` analytically (after Inigo Quilez's
 * `sdBezier`). Near-straight curves, where that cubic degenerates, fall
 * back to the chord segment.
 *
 * Returns `[distance, t]`.
 */
export function quadraticDistance(p: Vec2, A: Vec2, B: Vec2, C: Vec2): [number, number] {
  const ax = B[0] - A[0], ay = B[1] - A[1];
  const bx = A[0] - 2 * B[0] + C[0], by = A[1] - 2 * B[1] + C[1];
  const dx = A[0] - p[0], dy = A[1] - p[1];
  const bb = bx * bx + by * by;
  const aa = ax * ax + ay * ay;

  if (bb <= STRAIGHT_EPS * aa || bb < 1e-20) {
    // Chord segment A → C. With b ≈ 0 the curve is A + 2a·t, so the
    // projection parameter is also (to first order) the Bezier `t`.
    const ex = C[0] - A[0], ey = C[1] - A[1];
    const ee = ex * ex + ey * ey;
    const t = ee > 0 ? clamp01(-(dx * ex + dy * ey) / ee) : 0;
    return [Math.hypot(dx + ex * t, dy + ey * t), t];
  }

  const kk = 1 / bb;
  const kx = kk * (ax * bx + ay * by);
  const ky = (kk * (2 * aa + (dx * bx + dy * by))) / 3;
  const kz = kk * (dx * ax + dy * ay);
  const pp = ky - kx * kx;
  const q = kx * (2 * kx * kx - 3 * ky) + kz;
  const h = q * q + 4 * pp * pp * pp;

  const at = (t: number): number => {
    const x = dx + (2 * ax + bx * t) * t;
    const y = dy + (2 * ay + by * t) * t;
    return x * x + y * y;
  };

  if (h >= 0) {
    const hs = Math.sqrt(h);
    const u = Math.cbrt((hs - q) / 2);
    const v = Math.cbrt((-hs - q) / 2);
    const t = clamp01(u + v - kx);
    return [Math.sqrt(at(t)), t];
  }
  const z = Math.sqrt(-pp);
  const ang = Math.acos(q / (pp * z * 2)) / 3;
  const m = Math.cos(ang);
  const n = Math.sin(ang) * Math.sqrt(3);
  // The third root (−n − m) is never the minimum for a quadratic.
  const t1 = clamp01((m + m) * z - kx);
  const t2 = clamp01((-n - m) * z - kx);
  const d1 = at(t1), d2 = at(t2);
  return d1 < d2 ? [Math.sqrt(d1), t1] : [Math.sqrt(d2), t2];
}

/**
 * Signed distance from `p` to a tapered, growth-clipped branch: distance
 * to the clipped curve minus the taper radius at the closest point.
 * Negative inside. Exact for constant radius; for tapered branches it is
 * the usual cheap approximation (closest point on the spine, not on the
 * swept surface), which is accurate while the taper is gentle relative
 * to branch length.
 */
export function branchDistance(p: Vec2, b: TaperedBranch): number {
  if ((b.growth ?? 1) <= 0) return Infinity;
  const c = clipBranch(b);
  const [d, t] = quadraticDistance(p, c.p0, c.p1, c.p2);
  return d - lerp(c.r0, c.r1, t);
}

/**
 * Oriented bounding box of the clipped branch, padded by `pad` (the
 * renderer passes its anti-aliasing margin). The box is aligned with the
 * chord `P0 → P2`, which hugs thin diagonal branches far tighter than an
 * axis-aligned box. Returns the four corners counter-clockwise, or
 * `null` for a branch with no visible extent.
 */
export function branchBounds(b: TaperedBranch, pad = 0): Vec2[] | null {
  if ((b.growth ?? 1) <= 0) return null;
  const c = clipBranch(b);
  let ux = c.p2[0] - c.p0[0], uy = c.p2[1] - c.p0[1];
  const len = Math.hypot(ux, uy);
  if (len > 1e-9) { ux /= len; uy /= len; } else { ux = 1; uy = 0; }
  const vx = -uy, vy = ux;
  const pts = [c.p0, c.p1, c.p2];
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const q of pts) {
    const pu = q[0] * ux + q[1] * uy;
    const pv = q[0] * vx + q[1] * vy;
    u0 = Math.min(u0, pu); u1 = Math.max(u1, pu);
    v0 = Math.min(v0, pv); v1 = Math.max(v1, pv);
  }
  const r = Math.max(c.r0, c.r1) + pad;
  u0 -= r; u1 += r; v0 -= r; v1 += r;
  const corner = (u: number, v: number): Vec2 => [u * ux + v * vx, u * uy + v * vy];
  return [corner(u0, v0), corner(u1, v0), corner(u1, v1), corner(u0, v1)];
}

/** `|b|² ≤ STRAIGHT_EPS·|a|²` counts as straight (control point within
 *  ~0.3% of the chord midpoint), where the cubic solve loses precision. */
const STRAIGHT_EPS = 1e-5;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
