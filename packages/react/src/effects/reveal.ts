import type { EffectDefinition, EffectFrame, EffectRuntime } from './types';

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

export const reveal: EffectDefinition = {
  name: 'reveal',
  needsPointer: false,
  scrollTrigger: true,
  create({ pathCount, reducedMotion }): EffectRuntime {
    const settled: EffectFrame = {
      pathOffsets: splitOffsets(pathCount, 0),
      opacity: 1,
      sminK: SMIN_K,
    };
    const poised: EffectFrame = {
      pathOffsets: splitOffsets(pathCount, 1),
      opacity: pathCount === 1 ? 0 : 1,
      sminK: SMIN_K,
    };

    if (reducedMotion) {
      return {
        frame: () => settled,
        active: () => false,
      };
    }

    // `null` = not yet triggered. The component calls `replay(now)` on
    // mount (autoPlay) or on first IntersectionObserver hit (default).
    let startMs: number | null = null;

    return {
      frame(now) {
        if (startMs === null) return poised;
        const t = Math.min(1, Math.max(0, (now - startMs) / DURATION_MS));
        const eased = easeOutCubic(t);
        const split = 1 - eased;
        return {
          pathOffsets: splitOffsets(pathCount, split),
          opacity: pathCount === 1 ? eased : 1,
          sminK: SMIN_K,
        };
      },
      active(now) {
        if (startMs === null) return false;
        return now - startMs < DURATION_MS;
      },
      replay(now) {
        startMs = now;
      },
    };
  },
};
