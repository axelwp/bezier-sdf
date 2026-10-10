import type { CubicSegment } from './types';
import { quadAsCubic } from './parseSvgPath';

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
  /**
   * Upper bound on the number of chains emitted. Chains are generated
   * breadth-first, so hitting the cap drops the finest twigs first.
   * Defaults to {@link DEFAULT_MAX_BRANCHES}.
   */
  readonly maxBranches?: number;
}

/** Default for {@link TreeParams.maxBranches}. */
export const DEFAULT_MAX_BRANCHES = 4096;

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
  /**
   * Time this chain takes to grow from base to tip; the tree's
   * `params.growthDuration`, carried here so growth helpers can't be
   * driven with a duration that disagrees with the spawn times.
   */
  readonly growthDuration: number;
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
  length: number;
  radius: number;
  depth: number;
  side: 1 | -1;
}

/** A chain waiting to be grown; see `generateTree`. */
interface PendingChain {
  base: Vec2;
  angle: number;
  startLength: number;
  startRadius: number;
  startDepth: number;
  spawnTime: number;
  side: 1 | -1 | 0;
  firstSide: 1 | -1;
  parent: number;
}

function requireNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`generateTree: ${name} must be a finite non-negative number, got ${value}`);
  }
}

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`generateTree: ${name} must be a finite number, got ${value}`);
  }
}

/**
 * Grow a tree. Branches are returned parents-first (the trunk is index 0),
 * so `parent` always points at an earlier entry. Chains are emitted
 * breadth-first and generation stops once `maxBranches` chains exist.
 *
 * Throws a `RangeError` for parameters outside their valid range.
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
  const maxBranches = params.maxBranches ?? DEFAULT_MAX_BRANCHES;
  if (!Number.isInteger(maxBranches) || maxBranches < 1) {
    throw new RangeError(`generateTree: maxBranches must be a positive integer, got ${maxBranches}`);
  }
  requireNonNegative('trunkLength', params.trunkLength);
  requireNonNegative('trunkRadius', params.trunkRadius);
  requireNonNegative('lengthRatio', params.lengthRatio);
  requireNonNegative('radiusRatio', params.radiusRatio);
  requireNonNegative('growthDuration', params.growthDuration);
  requireFinite('tiltAngle', params.tiltAngle);
  requireFinite('gravity', params.gravity);
  if (params.angle !== undefined) requireFinite('angle', params.angle);
  if (params.origin !== undefined) {
    requireFinite('origin[0]', params.origin[0]);
    requireFinite('origin[1]', params.origin[1]);
  }

  const { growthDuration } = params;
  const out: TreeBranch[] = [];
  const queue: PendingChain[] = [{
    base: params.origin ?? [0, -1],
    angle: params.angle ?? Math.PI / 2,
    startLength: params.trunkLength,
    startRadius: params.trunkRadius,
    startDepth: params.depth,
    spawnTime: 0,
    side: 0,
    firstSide: params.firstSide ?? 1,
    parent: -1,
  }];

  for (let q = 0; q < queue.length && out.length < maxBranches; q++) {
    const { base, angle, startLength, startRadius, startDepth, spawnTime, side, firstSide, parent } =
      queue[q]!;
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
    out.push({
      a: base, c, b, ra: startRadius, rb: tipRadius, spawnTime, growthDuration,
      depth: startDepth, side, parent,
    });

    for (const lat of laterals) {
      // Chains past the cap would never be emitted; don't queue them.
      if (queue.length >= maxBranches) break;
      // A zero-length chain (trunkLength or lengthRatio 0) collapses to a
      // point; sprout everything from its base rather than dividing 0/0.
      const t = cumulativeLength > 0 ? lat.cumulativeLengthAtSprout / cumulativeLength : 0;
      // Tilt off the sagged curve's actual tangent at the sprout point, so
      // children follow a drooping parent. Fall back to the chain's
      // unsagged direction where the tangent vanishes.
      const [tx, ty] = quadraticTangent(base, c, b, t);
      const parentAngle = tx !== 0 || ty !== 0 ? Math.atan2(ty, tx) : angle;
      queue.push({
        base: evalQuadratic(base, c, b, t),
        angle: parentAngle + lat.side * params.tiltAngle,
        startLength: lat.length,
        startRadius: lat.radius,
        startDepth: lat.depth,
        spawnTime: spawnTime + t * growthDuration,
        side: lat.side,
        // Start each child's alternation back toward its parent's axis.
        firstSide: (-lat.side) as 1 | -1,
        parent: index,
      });
    }
  }

  return out;
}

/** Derivative (unnormalised) of the quadratic Bezier `a → c → b` at `t`. */
function quadraticTangent(a: Vec2, c: Vec2, b: Vec2, t: number): [number, number] {
  const mt = 1 - t;
  return [
    2 * (mt * (c[0] - a[0]) + t * (b[0] - c[0])),
    2 * (mt * (c[1] - a[1]) + t * (b[1] - c[1])),
  ];
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
 * tree-marching shader: zero before `spawnTime`, then linear over the
 * branch's `growthDuration`.
 */
export function branchGrowth(branch: TreeBranch, time: number): number {
  const { growthDuration } = branch;
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
 * Branches that haven't spawned yet are left out; `parent` indices are
 * remapped to the returned array (-1 if a parent was left out, which
 * can't happen for output of {@link generateTree}, since a child never
 * spawns before its parent).
 */
export function treeAtTime(branches: readonly TreeBranch[], time: number): TreeBranch[] {
  const out: TreeBranch[] = [];
  const outIndex = new Map<number, number>();
  branches.forEach((br, i) => {
    const g = branchGrowth(br, time);
    if (g <= 0) return;
    const grown = growBranch(br, g);
    const parent = br.parent >= 0 ? (outIndex.get(br.parent) ?? -1) : -1;
    outIndex.set(i, out.length);
    out.push(parent === br.parent ? grown : { ...grown, parent });
  });
  return out;
}

/**
 * Exact degree elevation of a branch's quadratic to the package's cubic
 * segment format, so a tree can be fed to the existing path tools.
 */
export function branchToCubic(branch: TreeBranch): CubicSegment {
  const { a, c, b } = branch;
  return quadAsCubic(a[0], a[1], c[0], c[1], b[0], b[1]);
}

/** Floats per branch in {@link packBranches}: three vec4s. */
export const BRANCH_STRIDE = 12;

/**
 * Flatten branches for upload to a GPU buffer, three vec4s per branch:
 *
 *   [a.x, a.y, c.x, c.y,  b.x, b.y, ra, rb,  spawnTime, depth, growthDuration, 0]
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
    out[o + 10] = br.growthDuration;
  });
  return out;
}
