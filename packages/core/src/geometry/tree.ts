import type { CubicSegment } from './types';

/**
 * Procedural 2D tree growth, ported from the 3D generator in
 * `axelwp/tree-marching` (src/sdf/tree.ts).
 *
 * The tree is a recursive set of *axial chains*. A chain is a run of
 * nodes that keeps going in one direction (the trunk, or one limb); each
 * node may sprout laterals, and each lateral starts a new chain one level
 * shallower. Every chain is emitted as a single quadratic Bezier with a
 * linear radius taper, so a whole tree is a short list of curves that is
 * cheap to evaluate as an SDF and easy to interpolate between parameter
 * sets.
 *
 * Differences from the 3D version:
 *   - Directions are angles in the plane. Where the 3D version spread
 *     siblings around the parent with a golden-angle azimuth, the 2D
 *     version alternates laterals left/right along each chain.
 *   - A lateral's `spawnTime` is the moment its parent's growth front
 *     reaches the sprout point, so a child never appears ahead of the
 *     branch it grows from.
 *
 * Coordinates follow the rest of the package: `+y` is up, and the
 * defaults keep a tree roughly inside `|x|, |y| ≲ 1`.
 */

/** A 2D point or vector. */
export type Vec2 = readonly [number, number];

export interface TreeParams {
  /** Levels of recursion. The trunk is depth `depth`, leaf twigs depth 0. */
  readonly depth: number;
  /** Length of the trunk's first node. */
  readonly trunkLength: number;
  /** Radius at the base of the trunk. */
  readonly trunkRadius: number;
  /** Child length relative to its parent node. */
  readonly lengthRatio: number;
  /** Child radius relative to its parent node. */
  readonly radiusRatio: number;
  /** Angle between a lateral and its parent chain, in radians. */
  readonly tiltAngle: number;
  /**
   * Branching factor per node, counting the continuing axis. A node
   * sprouts `childrenPerNode - 1` laterals; 1 means no laterals.
   */
  readonly childrenPerNode: number;
  /** Time for one chain to grow from base to tip. */
  readonly growthDuration: number;
  /** How far near-horizontal chains droop. 0 disables sag. */
  readonly gravity: number;
  /** Base of the trunk. Defaults to `[0, -1]`. */
  readonly origin?: Vec2;
  /** Trunk direction in radians, counter-clockwise from +x. Defaults to up. */
  readonly angle?: number;
  /** Side of the trunk's first lateral: 1 = left, -1 = right. Defaults to 1. */
  readonly firstSide?: 1 | -1;
}

/**
 * One axial chain as a tapered quadratic Bezier `a → c → b`. The radius
 * runs linearly from `ra` at `a` to `rb` at `b`, matching `sdBezier` in
 * the tree-marching shader.
 */
export interface TreeBranch {
  readonly a: Vec2;
  readonly c: Vec2;
  readonly b: Vec2;
  readonly ra: number;
  readonly rb: number;
  /** Time at which this chain starts growing. */
  readonly spawnTime: number;
  /** Recursion depth this chain started at (trunk = `params.depth`). */
  readonly depth: number;
  /** Which side of its parent it sprouted from: 1 = left, -1 = right, 0 = trunk. */
  readonly side: 1 | -1 | 0;
  /** Index of the parent chain in the output array, or -1 for the trunk. */
  readonly parent: number;
}

/** Parameters that produce a small, balanced tree inside the unit square. */
export const DEFAULT_TREE_PARAMS: TreeParams = {
  depth: 3,
  trunkLength: 0.5,
  trunkRadius: 0.06,
  lengthRatio: 0.6,
  radiusRatio: 0.55,
  tiltAngle: Math.PI / 4,
  childrenPerNode: 3,
  growthDuration: 1.5,
  gravity: 0.3,
};

interface Lateral {
  cumulativeLengthAtSprout: number;
  angle: number;
  length: number;
  radius: number;
  depth: number;
  side: 1 | -1;
}

/**
 * Grow a tree. Branches are returned parents-first (the trunk is index 0),
 * so `parent` always points at an earlier entry.
 */
export function generateTree(params: TreeParams): TreeBranch[] {
  if (!Number.isInteger(params.depth) || params.depth < 0) {
    throw new RangeError(`generateTree: depth must be a non-negative integer, got ${params.depth}`);
  }
  if (!Number.isInteger(params.childrenPerNode) || params.childrenPerNode < 1) {
    throw new RangeError(
      `generateTree: childrenPerNode must be a positive integer, got ${params.childrenPerNode}`,
    );
  }

  const out: TreeBranch[] = [];

  function generateChain(
    base: Vec2,
    angle: number,
    startLength: number,
    startRadius: number,
    startDepth: number,
    spawnTime: number,
    side: 1 | -1 | 0,
    firstSide: 1 | -1,
    parent: number,
  ): void {
    const dir: Vec2 = [Math.cos(angle), Math.sin(angle)];
    let length = startLength;
    let radius = startRadius;
    let depth = startDepth;
    let cumulativeLength = 0;
    let lateralCount = 0;

    const laterals: Lateral[] = [];

    while (depth >= 0) {
      if (depth > 0) {
        for (let i = 1; i < params.childrenPerNode; i++) {
          const lateralSide: 1 | -1 = lateralCount % 2 === 0 ? firstSide : (-firstSide as 1 | -1);
          lateralCount++;
          // Siblings sprout progressively further along the node, never
          // in its first 30%, so they don't stack on the node's base.
          const tLocal = (i / params.childrenPerNode) * 0.7 + 0.3;
          laterals.push({
            cumulativeLengthAtSprout: cumulativeLength + length * tLocal,
            angle: angle + lateralSide * params.tiltAngle,
            length: length * params.lengthRatio,
            radius: radius * params.radiusRatio,
            depth: depth - 1,
            side: lateralSide,
          });
        }
      }

      cumulativeLength += length;
      if (depth === 0) break;

      // The axis continues a little longer than its laterals (×1.3), as in
      // the 3D version, so the leader stays dominant.
      length *= params.lengthRatio * 1.3;
      radius *= params.radiusRatio;
      depth--;
    }

    const tipRadius = radius * params.radiusRatio;
    const chainTip: Vec2 = [base[0] + dir[0] * cumulativeLength, base[1] + dir[1] * cumulativeLength];

    // The chain is straight before sag, so its direction is `dir`. Sag is
    // strongest for horizontal chains and zero for vertical ones; the
    // control point sags less than the tip so the curve bows downward.
    const horizontality = 1 - Math.abs(dir[1]);
    const tipSag = cumulativeLength * params.gravity * horizontality;
    const controlSag = tipSag * 0.4;
    const half = cumulativeLength / 2;
    const c: Vec2 = [base[0] + dir[0] * half, base[1] + dir[1] * half - controlSag];
    const b: Vec2 = [chainTip[0], chainTip[1] - tipSag];

    const index = out.length;
    out.push({ a: base, c, b, ra: startRadius, rb: tipRadius, spawnTime, depth: startDepth, side, parent });

    for (const lat of laterals) {
      const t = lat.cumulativeLengthAtSprout / cumulativeLength;
      generateChain(
        evalQuadratic(base, c, b, t),
        lat.angle,
        lat.length,
        lat.radius,
        lat.depth,
        spawnTime + t * params.growthDuration,
        lat.side,
        // Start each child's alternation back toward its parent's axis.
        (-lat.side) as 1 | -1,
        index,
      );
    }
  }

  generateChain(
    params.origin ?? [0, -1],
    params.angle ?? Math.PI / 2,
    params.trunkLength,
    params.trunkRadius,
    params.depth,
    0,
    0,
    params.firstSide ?? 1,
    -1,
  );
  return out;
}

/** Evaluate the quadratic Bezier `a → c → b` at `t` in `[0, 1]`. */
export function evalQuadratic(a: Vec2, c: Vec2, b: Vec2, t: number): [number, number] {
  const mt = 1 - t;
  const w0 = mt * mt;
  const w1 = 2 * mt * t;
  const w2 = t * t;
  return [w0 * a[0] + w1 * c[0] + w2 * b[0], w0 * a[1] + w1 * c[1] + w2 * b[1]];
}

/**
 * How far `branch` has grown at `time`, in `[0, 1]`. Same formula as the
 * tree-marching shader: zero before `spawnTime`, then linear over
 * `growthDuration`.
 */
export function branchGrowth(branch: TreeBranch, time: number, growthDuration: number): number {
  if (growthDuration <= 0) return time >= branch.spawnTime ? 1 : 0;
  return Math.min(1, Math.max(0, (time - branch.spawnTime) / growthDuration));
}

/**
 * The part of `branch` that exists at `growth` (0..1), as a branch of its
 * own: the curve is cut at `t = growth` by de Casteljau, so it retraces
 * the original exactly, and the tip radius is interpolated the same way.
 */
export function growBranch(branch: TreeBranch, growth: number): TreeBranch {
  const g = Math.min(1, Math.max(0, growth));
  if (g === 1) return branch;
  const { a, c } = branch;
  const c2: Vec2 = [a[0] + (c[0] - a[0]) * g, a[1] + (c[1] - a[1]) * g];
  const b2 = evalQuadratic(a, c, branch.b, g);
  return { ...branch, c: c2, b: b2, rb: branch.ra + (branch.rb - branch.ra) * g };
}

/**
 * Every branch that exists at `time`, trimmed to its current length.
 * Branches that haven't spawned yet are left out, so indices do not
 * line up with the input; use `parent` from the input array if needed.
 */
export function treeAtTime(
  branches: readonly TreeBranch[],
  time: number,
  growthDuration: number,
): TreeBranch[] {
  const out: TreeBranch[] = [];
  for (const br of branches) {
    const g = branchGrowth(br, time, growthDuration);
    if (g > 0) out.push(growBranch(br, g));
  }
  return out;
}

/**
 * Exact degree elevation of a branch's quadratic to the package's cubic
 * segment format, so a tree can be fed to the existing path tools.
 */
export function branchToCubic(branch: TreeBranch): CubicSegment {
  const { a, c, b } = branch;
  return [
    a[0], a[1],
    a[0] + (2 / 3) * (c[0] - a[0]), a[1] + (2 / 3) * (c[1] - a[1]),
    b[0] + (2 / 3) * (c[0] - b[0]), b[1] + (2 / 3) * (c[1] - b[1]),
    b[0], b[1],
  ];
}

/** Floats per branch in {@link packBranches}: three vec4s. */
export const BRANCH_STRIDE = 12;

/**
 * Flatten branches for upload to a GPU buffer, three vec4s per branch:
 *
 *   [a.x, a.y, c.x, c.y,  b.x, b.y, ra, rb,  spawnTime, depth, 0, 0]
 */
export function packBranches(branches: readonly TreeBranch[]): Float32Array {
  const out = new Float32Array(branches.length * BRANCH_STRIDE);
  branches.forEach((br, i) => {
    const o = i * BRANCH_STRIDE;
    out[o + 0] = br.a[0]; out[o + 1] = br.a[1];
    out[o + 2] = br.c[0]; out[o + 3] = br.c[1];
    out[o + 4] = br.b[0]; out[o + 5] = br.b[1];
    out[o + 6] = br.ra;   out[o + 7] = br.rb;
    out[o + 8] = br.spawnTime;
    out[o + 9] = br.depth;
  });
  return out;
}
