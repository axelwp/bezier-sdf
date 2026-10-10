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
 * `sdBezier`), then polishes each candidate root with a couple of Newton
 * steps: the closed form loses several digits in float32 (the GLSL twin)
 * on gently curved branches, and Newton restores full precision. On
 * near-straight curves, where the cubic degenerates, the Newton
 * iteration starts from the chord projection instead.
 *
 * Returns `[distance, t]`.
 */
export function quadraticDistance(p: Vec2, A: Vec2, B: Vec2, C: Vec2): [number, number] {
  const ax = B[0] - A[0], ay = B[1] - A[1];
  const bx = A[0] - 2 * B[0] + C[0], by = A[1] - 2 * B[1] + C[1];
  const dx = A[0] - p[0], dy = A[1] - p[1];
  const bb = bx * bx + by * by;
  const aa = ax * ax + ay * ay;

  // Squared distance to B(t) = A + 2a·t + b·t².
  const at = (t: number): number => {
    const x = dx + (2 * ax + bx * t) * t;
    const y = dy + (2 * ay + by * t) * t;
    return x * x + y * y;
  };
  // Newton on f(t) = dot(B(t) - p, B'(t)/2), clamped to [0, 1]. Stops
  // where f' ≤ 0, i.e. outside the basin of a distance minimum.
  const polish = (t: number): number => {
    for (let i = 0; i < POLISH_STEPS; i++) {
      const qx = dx + (2 * ax + bx * t) * t;
      const qy = dy + (2 * ay + by * t) * t;
      const tx = ax + bx * t, ty = ay + by * t;
      const fp = 2 * (tx * tx + ty * ty) + qx * bx + qy * by;
      if (!(fp > 0)) break;
      t = clamp01(t - (qx * tx + qy * ty) / fp);
    }
    return t;
  };

  if (bb <= STRAIGHT_EPS * aa || bb < 1e-20) {
    // Seed with the projection onto the chord A → C (with b ≈ 0 the curve
    // is A + 2a·t, so that is close to the Bezier `t`), then polish. Far
    // off a near-straight curve the distance need not be convex in t, so
    // also compare the endpoints, the only other possible minima there.
    const ex = C[0] - A[0], ey = C[1] - A[1];
    const ee = ex * ex + ey * ey;
    let t = polish(ee > 0 ? clamp01(-(dx * ex + dy * ey) / ee) : 0);
    let d = at(t);
    const d0 = at(0), d1 = at(1);
    if (d0 < d) { d = d0; t = 0; }
    if (d1 < d) { d = d1; t = 1; }
    return [Math.sqrt(d), t];
  }

  const kk = 1 / bb;
  const kx = kk * (ax * bx + ay * by);
  const ky = (kk * (2 * aa + (dx * bx + dy * by))) / 3;
  const kz = kk * (dx * ax + dy * ay);
  const pp = ky - kx * kx;
  const q = kx * (2 * kx * kx - 3 * ky) + kz;
  const h = q * q + 4 * pp * pp * pp;

  if (h >= 0) {
    const hs = Math.sqrt(h);
    const u = Math.cbrt((hs - q) / 2);
    const v = Math.cbrt((-hs - q) / 2);
    const t = polish(clamp01(u + v - kx));
    return [Math.sqrt(at(t)), t];
  }
  const z = Math.sqrt(-pp);
  // Rounding can push the ratio just outside acos's domain.
  const ang = Math.acos(Math.min(1, Math.max(-1, q / (pp * z * 2)))) / 3;
  const m = Math.cos(ang);
  const n = Math.sin(ang) * Math.sqrt(3);
  // Roots in order: (−n − m) ≤ (n − m) ≤ 2m (times z, minus kx). The
  // squared distance is a quartic in t, so the middle root is its local
  // maximum and is skipped; the outer two are the candidate minima.
  const t1 = polish(clamp01((m + m) * z - kx));
  const t2 = polish(clamp01((-n - m) * z - kx));
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
  const g = b.growth ?? 1;
  if (g <= 0) return null;
  const box = new Array<number>(BRANCH_BOX_STRIDE);
  writeBox(b.p0[0], b.p0[1], b.p1[0], b.p1[1], b.p2[0], b.p2[1], b.r0, b.r1, g, box, 0);
  const [ux, uy, u0, v0, u1, v1] = box as [number, number, number, number, number, number];
  const vx = -uy, vy = ux;
  const corner = (u: number, v: number): Vec2 => [u * ux + v * vx, u * uy + v * vy];
  return [
    corner(u0 - pad, v0 - pad), corner(u1 + pad, v0 - pad),
    corner(u1 + pad, v1 + pad), corner(u0 - pad, v1 + pad),
  ];
}

/** Floats per branch in the culling-box buffer: `[ux, uy, u0, v0, u1, v1]`. */
export const BRANCH_BOX_STRIDE = 6;

/**
 * Culling boxes for `count` branches packed in the {@link packBranches}
 * layout: per branch, the unit chord direction `u` and the box extents
 * `[u0, u1] × [v0, v1]` in the frame `(u, v = perp(u))`, padded by the
 * larger radius but not by any AA margin. This is the only
 * implementation of the box; `BranchRenderer` uploads its output
 * and the vertex shader just adds its pixel margin, and
 * {@link branchBounds} is built on the same code. Ungrown branches get
 * an all-zero box.
 *
 * Pass `out` to reuse a buffer across frames, as with `packBranches`.
 */
export function branchBoxes(packed: Float32Array, count: number, out?: Float32Array): Float32Array {
  const need = count * BRANCH_BOX_STRIDE;
  const buf = out && out.length >= need ? out : new Float32Array(need);
  for (let i = 0; i < count; i++) {
    const s = i * BRANCH_STRIDE;
    const g = packed[s + 8]!;
    if (!(g > 0)) {
      buf.fill(0, i * BRANCH_BOX_STRIDE, (i + 1) * BRANCH_BOX_STRIDE);
      continue;
    }
    writeBox(
      packed[s]!, packed[s + 1]!, packed[s + 2]!, packed[s + 3]!,
      packed[s + 4]!, packed[s + 5]!, packed[s + 6]!, packed[s + 7]!, g,
      buf, i * BRANCH_BOX_STRIDE,
    );
  }
  return buf;
}

/** Chord-aligned box around the clipped control hull (which contains
 *  the curve), padded by the larger radius. `g` must be > 0. */
function writeBox(
  p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number,
  r0: number, r1: number, growth: number,
  out: { [i: number]: number }, o: number,
): void {
  const g = Math.min(1, growth);
  // De Casteljau split at g, as in clipBranch.
  const q1x = lerp(p0x, p1x, g), q1y = lerp(p0y, p1y, g);
  const q2x = lerp(q1x, lerp(p1x, p2x, g), g), q2y = lerp(q1y, lerp(p1y, p2y, g), g);
  let ux = q2x - p0x, uy = q2y - p0y;
  const len = Math.hypot(ux, uy);
  if (len > 1e-9) { ux /= len; uy /= len; } else { ux = 1; uy = 0; }
  const vx = -uy, vy = ux;
  const a = p0x * ux + p0y * uy, b = q1x * ux + q1y * uy, c = q2x * ux + q2y * uy;
  const d = p0x * vx + p0y * vy, e = q1x * vx + q1y * vy, f = q2x * vx + q2y * vy;
  const r = Math.max(r0, lerp(r0, r1, g));
  out[o] = ux;
  out[o + 1] = uy;
  out[o + 2] = Math.min(a, b, c) - r;
  out[o + 3] = Math.min(d, e, f) - r;
  out[o + 4] = Math.max(a, b, c) + r;
  out[o + 5] = Math.max(d, e, f) + r;
}

/**
 * `|b|² ≤ STRAIGHT_EPS·|a|²` counts as near-straight: the control point
 * lies within ~0.8% of the chord length (`√STRAIGHT_EPS / 4`) of the
 * chord midpoint. The test is relative, so the cut-off scales with branch
 * length, but it only picks the Newton seed (chord projection vs. cubic
 * roots); both paths are polished to full precision, so it costs no
 * accuracy. The polished float32 cubic stays accurate an order of magnitude
 * below this, so the margin is generous.
 */
export const STRAIGHT_EPS = 1e-3;
/** Newton steps applied to every candidate parameter. */
export const POLISH_STEPS = 2;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
