import type { Effect } from './types';

const DURATION_MS = 1400;
const START_OFFSET = 0.3;
const SMIN_K = 0.08;

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Distribute N paths around the origin with magnitude `split * START_OFFSET`.
 *
 *   split = 1 → pre-reveal (paths spread out, meeting the others near origin
 *               through the soft union set by sminK)
 *   split = 0 → fully resolved (all paths at origin, at baked position)
 *
 * For 2 paths we use the brief-specified horizontal split (±0.3). For 3+
 * paths we spread evenly around a circle — no obvious "correct" geometry
 * exists, but equiangular placement at least keeps the union centered.
 */
function splitOffsets(pathCount: number, split: number): Array<[number, number]> {
  if (pathCount <= 1) return pathCount === 1 ? [[0, 0]] : [];
  if (pathCount === 2) {
    return [
      [ START_OFFSET * split, 0],
      [-START_OFFSET * split, 0],
    ];
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pathCount; i++) {
    const angle = (i / pathCount) * Math.PI * 2;
    out.push([
      Math.cos(angle) * START_OFFSET * split,
      Math.sin(angle) * START_OFFSET * split,
    ]);
  }
  return out;
}

/**
 * The intro effect from the README prototype: multi-path logos split outward
 * before the reveal and ease together to their baked positions; single-path
 * logos fade from 0 → 1 opacity over the same window (since there's nothing
 * to split).
 */
export const reveal: Effect = {
  name: 'reveal',
  durationMs: DURATION_MS,
  initial(pathCount) {
    return {
      pathOffsets: splitOffsets(pathCount, 1),
      opacity: pathCount === 1 ? 0 : 1,
      sminK: SMIN_K,
      done: false,
    };
  },
  at(elapsed, pathCount) {
    const t = Math.min(1, Math.max(0, elapsed / DURATION_MS));
    const eased = easeOutCubic(t);
    const split = 1 - eased;
    return {
      pathOffsets: splitOffsets(pathCount, split),
      opacity: pathCount === 1 ? eased : 1,
      sminK: SMIN_K,
      done: t >= 1,
    };
  },
};
