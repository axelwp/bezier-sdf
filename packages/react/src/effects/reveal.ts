import type { EffectDefinition, EffectFrame, EffectRuntime } from './types';

export interface RevealParams {
  /** Total animation length in ms. */
  duration?: number;
  /** Initial path displacement magnitude (SDF units). */
  startOffset?: number;
  /** Soft-union radius used during reveal. */
  sminK?: number;
}

const DEFAULTS = {
  duration: 1400,
  startOffset: 0.3,
  sminK: 0.08,
};

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Distribute N paths around the origin with magnitude `split * startOffset`.
 *
 *   split = 1 → pre-reveal (paths spread out, meeting the others near origin
 *               through the soft union set by sminK)
 *   split = 0 → fully resolved (all paths at origin, at baked position)
 */
function splitOffsets(pathCount: number, split: number, startOffset: number): Array<[number, number]> {
  if (pathCount <= 1) return pathCount === 1 ? [[0, 0]] : [];
  if (pathCount === 2) {
    return [
      [ startOffset * split, 0],
      [-startOffset * split, 0],
    ];
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pathCount; i++) {
    const angle = (i / pathCount) * Math.PI * 2;
    out.push([
      Math.cos(angle) * startOffset * split,
      Math.sin(angle) * startOffset * split,
    ]);
  }
  return out;
}

export const reveal: EffectDefinition = {
  name: 'reveal',
  needsPointer: false,
  scrollTrigger: true,
  create({ pathCount, reducedMotion, params }): EffectRuntime {
    const initial = params as RevealParams | undefined;
    let duration = initial?.duration ?? DEFAULTS.duration;
    let startOffset = initial?.startOffset ?? DEFAULTS.startOffset;
    let sminK = initial?.sminK ?? DEFAULTS.sminK;

    const settledFrame = (): EffectFrame => ({
      pathOffsets: splitOffsets(pathCount, 0, startOffset),
      opacity: 1,
      sminK,
    });
    const poisedFrame = (): EffectFrame => ({
      pathOffsets: splitOffsets(pathCount, 1, startOffset),
      opacity: pathCount === 1 ? 0 : 1,
      sminK,
    });

    if (reducedMotion) {
      return {
        frame: () => settledFrame(),
        active: () => false,
      };
    }

    // `null` = not yet triggered. The component calls `replay(now)` on
    // mount (autoPlay) or on first IntersectionObserver hit (default).
    let startMs: number | null = null;

    return {
      frame(now) {
        if (startMs === null) return poisedFrame();
        const t = Math.min(1, Math.max(0, (now - startMs) / duration));
        const eased = easeOutCubic(t);
        const split = 1 - eased;
        return {
          pathOffsets: splitOffsets(pathCount, split, startOffset),
          opacity: pathCount === 1 ? eased : 1,
          sminK,
        };
      },
      active(now) {
        if (startMs === null) return false;
        return now - startMs < duration;
      },
      replay(now) {
        startMs = now;
      },
      setParams(p) {
        const rp = p as RevealParams;
        if (typeof rp.duration === 'number') duration = rp.duration;
        if (typeof rp.startOffset === 'number') startOffset = rp.startOffset;
        if (typeof rp.sminK === 'number') sminK = rp.sminK;
      },
    };
  },
};
