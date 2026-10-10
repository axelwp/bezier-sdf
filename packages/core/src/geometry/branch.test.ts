import { describe, it, expect } from 'vitest';
import {
  BRANCH_STRIDE,
  branchBounds,
  branchDistance,
  clipBranch,
  packBranches,
  quadraticDistance,
  type TaperedBranch,
  type Vec2,
} from './branch';

const evalQuad = (A: Vec2, B: Vec2, C: Vec2, t: number): Vec2 => {
  const s = 1 - t;
  return [s * s * A[0] + 2 * s * t * B[0] + t * t * C[0], s * s * A[1] + 2 * s * t * B[1] + t * t * C[1]];
};

/** Brute-force reference: dense sampling plus local refinement. */
const bruteDistance = (p: Vec2, A: Vec2, B: Vec2, C: Vec2): number => {
  let best = Infinity;
  const N = 4000;
  for (let i = 0; i <= N; i++) {
    const q = evalQuad(A, B, C, i / N);
    best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1]));
  }
  return best;
};

// Deterministic PRNG so failures reproduce.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

describe('quadraticDistance', () => {
  it('matches brute-force sampling on random curves and points', () => {
    const r = rng(7);
    const v = (): Vec2 => [r() * 2 - 1, r() * 2 - 1];
    for (let i = 0; i < 300; i++) {
      const A = v(), B = v(), C = v(), p = v();
      const [d] = quadraticDistance(p, A, B, C);
      expect(d).toBeCloseTo(bruteDistance(p, A, B, C), 4);
    }
  });

  it('returns the closest-point parameter', () => {
    const A: Vec2 = [-1, 0], B: Vec2 = [0, 1], C: Vec2 = [1, 0];
    const [d, t] = quadraticDistance([0, 2], A, B, C);
    expect(t).toBeCloseTo(0.5, 9);
    expect(d).toBeCloseTo(1.5, 9);
  });

  it('handles straight curves (control point at the chord midpoint)', () => {
    const A: Vec2 = [0, 0], B: Vec2 = [0.5, 0], C: Vec2 = [1, 0];
    expect(quadraticDistance([0.25, 0.3], A, B, C)[0]).toBeCloseTo(0.3, 9);
    expect(quadraticDistance([0.25, 0.3], A, B, C)[1]).toBeCloseTo(0.25, 9);
    expect(quadraticDistance([2, 0], A, B, C)[0]).toBeCloseTo(1, 9);
  });

  it('handles a fully degenerate (point) curve', () => {
    const P: Vec2 = [0.2, 0.2];
    expect(quadraticDistance([0.2, 0.5], P, P, P)[0]).toBeCloseTo(0.3, 9);
  });
});

describe('clipBranch', () => {
  const b: TaperedBranch = { p0: [0, 0], p1: [0.5, 1], p2: [1, 0], r0: 0.1, r1: 0.02 };

  it('is the identity at full growth', () => {
    const c = clipBranch(b);
    expect(c.p1).toEqual(b.p1);
    expect(c.p2).toEqual(b.p2);
    expect(c.r1).toBeCloseTo(0.02, 12);
  });

  it('ends on the original curve and keeps its taper', () => {
    const g = 0.4;
    const c = clipBranch({ ...b, growth: g });
    const tip = evalQuad(b.p0, b.p1, b.p2, g);
    expect(c.p2[0]).toBeCloseTo(tip[0], 12);
    expect(c.p2[1]).toBeCloseTo(tip[1], 12);
    expect(c.r1).toBeCloseTo(0.1 + (0.02 - 0.1) * g, 12);
    // Clipped curve traces the same points as the original's [0, g].
    for (const s of [0.1, 0.5, 0.9]) {
      const q = evalQuad(c.p0, c.p1, c.p2, s);
      const o = evalQuad(b.p0, b.p1, b.p2, s * g);
      expect(q[0]).toBeCloseTo(o[0], 12);
      expect(q[1]).toBeCloseTo(o[1], 12);
    }
  });
});

describe('branchDistance', () => {
  const b: TaperedBranch = { p0: [0, 0], p1: [0.5, 0], p2: [1, 0], r0: 0.2, r1: 0.1 };

  it('subtracts the tapered radius', () => {
    expect(branchDistance([0, 0.5], b)).toBeCloseTo(0.3, 9);
    expect(branchDistance([1, 0.5], b)).toBeCloseTo(0.4, 9);
    expect(branchDistance([0.5, 0], b)).toBeCloseTo(-0.15, 9);
  });

  it('clips at the growth parameter', () => {
    // Half grown: tip at x=0.5 with radius 0.15; a point at x=1 is now
    // 0.5 from the tip.
    expect(branchDistance([1, 0], { ...b, growth: 0.5 })).toBeCloseTo(0.5 - 0.15, 9);
  });

  it('is infinitely far when not yet grown', () => {
    expect(branchDistance([0, 0], { ...b, growth: 0 })).toBe(Infinity);
  });
});

describe('branchBounds', () => {
  it('contains every point with negative distance', () => {
    const r = rng(11);
    const b: TaperedBranch = { p0: [-0.6, -0.7], p1: [0.4, -0.1], p2: [0.1, 0.8], r0: 0.08, r1: 0.01, growth: 0.8 };
    const box = branchBounds(b)!;
    const inside = (p: Vec2) => box.every((a, i) => {
      const c = box[(i + 1) % 4]!;
      return (c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]) >= -1e-12;
    });
    for (let i = 0; i < 5000; i++) {
      const p: Vec2 = [r() * 2 - 1, r() * 2 - 1];
      if (branchDistance(p, b) < 0) expect(inside(p)).toBe(true);
    }
  });

  it('is null for an ungrown branch', () => {
    expect(branchBounds({ p0: [0, 0], p1: [1, 1], p2: [2, 0], r0: 1, r1: 1, growth: 0 })).toBeNull();
  });
});

describe('packBranches', () => {
  it('packs the instance layout and defaults growth to 1', () => {
    const buf = packBranches([{ p0: [1, 2], p1: [3, 4], p2: [5, 6], r0: 7, r1: 8 }]);
    expect(Array.from(buf)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 1]);
    expect(buf.length).toBe(BRANCH_STRIDE);
  });

  it('reuses a large-enough output buffer', () => {
    const out = new Float32Array(BRANCH_STRIDE * 4);
    expect(packBranches([{ p0: [0, 0], p1: [0, 0], p2: [0, 0], r0: 0, r1: 0 }], out)).toBe(out);
  });
});
