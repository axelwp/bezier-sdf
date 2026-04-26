import type { EffectDefinition, EffectRuntime } from './types';

/**
 * Tuning for the hover-driven morph between two shapes.
 *
 *   rate — exponential approach rate, units `1/s`. The smoothed `t`
 *          follows the hover target via `t += (target - t) * (1 - exp(-rate*dt))`.
 *          rate ≈ 15 reaches ~95% of the target in ~200 ms — the spec
 *          default for "snappy but not jarring."
 */
export interface MorphParams {
  rate?: number;
}

const DEFAULTS = {
  rate: 15,
};

/** |target - t| under this is treated as settled (rAF can pause). */
const REST_EPS = 1e-3;

/**
 * Hover-driven shape-to-shape morph.
 *
 * Pointer enters the canvas → target = 1, pointer leaves → target = 0.
 * The smoothed `t` exponentially approaches the target with a critically-
 * damped first-order step (no overshoot), settling in ~0.2 s by default.
 *
 * Reduced-motion mode: stay at t = 0 (shape A) and don't animate.
 *
 * Renders entirely through the morph sample pipeline — no per-path
 * machinery is touched. The component reads `morphT` from the merged
 * frame and packs it into `Uniforms.morph.t` along with the configured
 * colors.
 */
export const morph: EffectDefinition = {
  name: 'morph',
  needsPointer: true,
  scrollTrigger: false,
  create({ reducedMotion, params }): EffectRuntime {
    const initial = params as MorphParams | undefined;
    let rate = initial?.rate ?? DEFAULTS.rate;

    let target = 0;
    let t = 0;
    let lastNow: number | null = null;

    if (reducedMotion) {
      return {
        frame: () => ({ morphT: 0 }),
        active: () => false,
      };
    }

    return {
      frame(now) {
        if (lastNow === null) {
          lastNow = now;
          return { morphT: t };
        }
        const dt = Math.max(0, (now - lastNow) / 1000);
        lastNow = now;
        // Critically-damped exponential lerp: stable at any dt because
        // the step is bounded by (target - t). No overshoot.
        const k = 1 - Math.exp(-rate * dt);
        t += (target - t) * k;
        return { morphT: t };
      },
      active() {
        return Math.abs(target - t) > REST_EPS;
      },
      pointerMove() {
        if (target !== 1) {
          target = 1;
          // Drop the stale timestamp so the next frame measures dt from
          // the hover, not from mount. Otherwise the first hover snaps
          // straight to t=1 because dt has been accumulating since
          // mount while the rAF loop was idle.
          lastNow = null;
        }
      },
      pointerLeave() {
        if (target !== 0) {
          target = 0;
          lastNow = null;
        }
      },
      pointerDown() {
        // Touch: tap toggles between endpoints. Without a hover model the
        // morph would otherwise be unreachable on touch devices.
        target = target < 0.5 ? 1 : 0;
        lastNow = null;
      },
      setParams(p) {
        const mp = p as MorphParams;
        if (typeof mp.rate === 'number') rate = mp.rate;
      },
    };
  },
};
