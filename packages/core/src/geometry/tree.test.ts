import { describe, it, expect } from 'vitest';
import {
  generateTree,
  evalQuadratic,
  branchGrowth,
  growBranch,
  treeAtTime,
  branchToCubic,
  packBranches,
  BRANCH_STRIDE,
  DEFAULT_TREE_PARAMS,
  type TreeParams,
  type TreeBranch,
} from './tree';
import { evalCubic } from './sampling';

const params = (overrides: Partial<TreeParams> = {}): TreeParams => ({
  ...DEFAULT_TREE_PARAMS,
  ...overrides,
});

/** Closest point on the quadratic, by dense sampling. */
function distToCurve(br: TreeBranch, p: readonly [number, number]): number {
  let best = Infinity;
  for (let i = 0; i <= 1000; i++) {
    const [x, y] = evalQuadratic(br.a, br.c, br.b, i / 1000);
    best = Math.min(best, Math.hypot(x - p[0], y - p[1]));
  }
  return best;
}

describe('generateTree', () => {
  it('emits a single straight trunk at depth 0', () => {
    const tree = generateTree(params({ depth: 0, trunkLength: 1, gravity: 1 }));
    expect(tree).toHaveLength(1);
    const [trunk] = tree;
    expect(trunk!.a).toEqual([0, -1]);
    expect(trunk!.b[0]).toBeCloseTo(0, 12);
    expect(trunk!.b[1]).toBeCloseTo(0, 12);
    // Vertical chains don't sag.
    expect(trunk!.c[0]).toBeCloseTo(0, 12);
    expect(trunk!.c[1]).toBeCloseTo(-0.5, 12);
    expect(trunk!.parent).toBe(-1);
    expect(trunk!.side).toBe(0);
    expect(trunk!.spawnTime).toBe(0);
  });

  it('produces one chain per lateral: 1 + (k-1)·d per level', () => {
    // childrenPerNode 2 → one lateral per node. A chain at depth d has
    // d branching nodes, each spawning a chain of depth d-1, so
    // N(d) = 1 + Σ_{j<d} N(j) = 2^d.
    for (let d = 0; d <= 4; d++) {
      expect(generateTree(params({ depth: d, childrenPerNode: 2 }))).toHaveLength(2 ** d);
    }
    // childrenPerNode 1 → no laterals at all.
    expect(generateTree(params({ depth: 4, childrenPerNode: 1 }))).toHaveLength(1);
  });

  it('lists parents before children and roots every lateral on its parent curve', () => {
    const tree = generateTree(params({ depth: 3, gravity: 0.8 }));
    tree.forEach((br, i) => {
      if (i === 0) return;
      expect(br.parent).toBeGreaterThanOrEqual(0);
      expect(br.parent).toBeLessThan(i);
      expect(br.depth).toBeLessThan(tree[br.parent]!.depth);
      expect(distToCurve(tree[br.parent]!, br.a)).toBeLessThan(1e-3);
    });
  });

  it('alternates laterals left and right along a chain', () => {
    const tree = generateTree(params({ depth: 4, childrenPerNode: 2, gravity: 0 }));
    const trunkKids = tree.filter((b) => b.parent === 0);
    expect(trunkKids.map((b) => b.side)).toEqual([1, -1, 1, -1]);
    // Left of an upward trunk is -x.
    expect(trunkKids[0]!.b[0]).toBeLessThan(trunkKids[0]!.a[0]);
    expect(trunkKids[1]!.b[0]).toBeGreaterThan(trunkKids[1]!.a[0]);

    // A child's first lateral turns back toward its parent's axis.
    const firstKid = tree.indexOf(trunkKids[0]!);
    const grandKids = tree.filter((b) => b.parent === firstKid);
    expect(grandKids[0]!.side).toBe(-trunkKids[0]!.side);
  });

  it('respects firstSide', () => {
    const tree = generateTree(params({ depth: 2, childrenPerNode: 2, firstSide: -1 }));
    expect(tree.filter((b) => b.parent === 0)[0]!.side).toBe(-1);
  });

  it('mirrors exactly when firstSide flips', () => {
    const l = generateTree(params({ depth: 3, firstSide: 1 }));
    const r = generateTree(params({ depth: 3, firstSide: -1 }));
    expect(r).toHaveLength(l.length);
    l.forEach((br, i) => {
      const m = r[i]!;
      for (const k of ['a', 'c', 'b'] as const) {
        expect(m[k][0]).toBeCloseTo(-br[k][0], 12);
        expect(m[k][1]).toBeCloseTo(br[k][1], 12);
      }
    });
  });

  it('tapers radius from parent to child', () => {
    const tree = generateTree(params({ depth: 3 }));
    for (const br of tree) {
      expect(br.rb).toBeLessThan(br.ra);
      if (br.parent >= 0) expect(br.ra).toBeLessThan(tree[br.parent]!.ra);
    }
  });

  it('makes horizontal chains sag under gravity and leaves them straight without it', () => {
    const flat = (gravity: number) =>
      generateTree(params({ depth: 0, angle: 0, origin: [0, 0], trunkLength: 1, gravity }))[0]!;

    const straight = flat(0);
    expect(straight.b).toEqual([1, 0]);
    expect(straight.c).toEqual([0.5, 0]);

    const droop = flat(0.5);
    expect(droop.b[1]).toBeCloseTo(-0.5, 12);
    expect(droop.c[1]).toBeCloseTo(-0.2, 12);
    // Starts out along the original direction-ish, then bends down.
    expect(droop.b[1]).toBeLessThan(droop.c[1]);
  });

  it('spawns each lateral when its parent reaches the sprout point', () => {
    const growthDuration = 2;
    const tree = generateTree(params({ depth: 3, growthDuration, gravity: 0.5 }));
    for (const br of tree.slice(1)) {
      const p = tree[br.parent]!;
      expect(br.spawnTime).toBeGreaterThan(p.spawnTime);
      expect(br.spawnTime).toBeLessThanOrEqual(p.spawnTime + growthDuration);
      // At spawn time, the parent's growing tip sits on the child's base.
      const grown = growBranch(p, branchGrowth(p, br.spawnTime, growthDuration));
      expect(Math.hypot(grown.b[0] - br.a[0], grown.b[1] - br.a[1])).toBeLessThan(1e-9);
    }
  });

  it('fits the default tree in the unit square', () => {
    for (const br of generateTree(DEFAULT_TREE_PARAMS)) {
      for (const p of [br.a, br.c, br.b]) {
        expect(Math.abs(p[0])).toBeLessThanOrEqual(1);
        expect(Math.abs(p[1])).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic and changes continuously with its parameters', () => {
    expect(generateTree(DEFAULT_TREE_PARAMS)).toEqual(generateTree(DEFAULT_TREE_PARAMS));
    const a = generateTree(params({ tiltAngle: 0.7 }));
    const b = generateTree(params({ tiltAngle: 0.7 + 1e-6 }));
    expect(b).toHaveLength(a.length);
    a.forEach((br, i) => {
      expect(Math.hypot(br.b[0] - b[i]!.b[0], br.b[1] - b[i]!.b[1])).toBeLessThan(1e-4);
    });
  });

  it('rejects invalid structure parameters', () => {
    expect(() => generateTree(params({ depth: -1 }))).toThrow(RangeError);
    expect(() => generateTree(params({ depth: 1.5 }))).toThrow(RangeError);
    expect(() => generateTree(params({ childrenPerNode: 0 }))).toThrow(RangeError);
  });
});

describe('growth', () => {
  const br = generateTree(params({ depth: 0, angle: 0, origin: [0, 0], trunkLength: 1, gravity: 0.5 }))[0]!;

  it('branchGrowth clamps to [0, 1] around spawnTime', () => {
    const late = { ...br, spawnTime: 1 };
    expect(branchGrowth(late, 0.5, 2)).toBe(0);
    expect(branchGrowth(late, 2, 2)).toBe(0.5);
    expect(branchGrowth(late, 10, 2)).toBe(1);
    expect(branchGrowth(late, 1, 0)).toBe(1);
    expect(branchGrowth(late, 0.9, 0)).toBe(0);
  });

  it('growBranch retraces the original curve and interpolates the radius', () => {
    const half = growBranch(br, 0.5);
    expect(half.a).toEqual(br.a);
    expect(half.rb).toBeCloseTo((br.ra + br.rb) / 2, 12);
    for (let i = 0; i <= 10; i++) {
      const s = i / 10;
      const [x, y] = evalQuadratic(half.a, half.c, half.b, s);
      const [ex, ey] = evalQuadratic(br.a, br.c, br.b, s * 0.5);
      expect(x).toBeCloseTo(ex, 12);
      expect(y).toBeCloseTo(ey, 12);
    }
    expect(growBranch(br, 1)).toBe(br);
  });

  it('treeAtTime drops unspawned branches and grows the rest', () => {
    const tree = generateTree(params({ depth: 2 }));
    const d = DEFAULT_TREE_PARAMS.growthDuration;
    expect(treeAtTime(tree, -1, d)).toHaveLength(0);
    expect(treeAtTime(tree, 0.01, d)).toHaveLength(1);
    expect(treeAtTime(tree, 100, d)).toEqual(tree);
  });
});

describe('branchToCubic', () => {
  it('traces the same curve as the quadratic', () => {
    const br = generateTree(params({ depth: 0, angle: 0.3, gravity: 0.7 }))[0]!;
    const cubic = branchToCubic(br);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const [qx, qy] = evalQuadratic(br.a, br.c, br.b, t);
      const [cx, cy] = evalCubic(cubic, t);
      expect(cx).toBeCloseTo(qx, 12);
      expect(cy).toBeCloseTo(qy, 12);
    }
  });
});

describe('packBranches', () => {
  it('packs three vec4s per branch', () => {
    const tree = generateTree(params({ depth: 1, childrenPerNode: 2 }));
    const buf = packBranches(tree);
    expect(buf).toHaveLength(tree.length * BRANCH_STRIDE);
    const br = tree[1]!;
    const o = BRANCH_STRIDE;
    expect(Array.from(buf.slice(o, o + 10))).toEqual(
      Array.from(
        new Float32Array([br.a[0], br.a[1], br.c[0], br.c[1], br.b[0], br.b[1], br.ra, br.rb, br.spawnTime, br.depth]),
      ),
    );
    expect(buf[o + 10]).toBe(0);
    expect(buf[o + 11]).toBe(0);
  });
});
