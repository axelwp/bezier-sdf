import type { EffectDefinition, EffectRuntime } from './types';

/**
 * Tuning for the shader-side Gaussian cursor pull. Values are in
 * normalized SDF space (the same coordinates the cursor lives in).
 *
 *   pull   — peak SDF deformation at the cursor (subtracted from the
 *            sampled distance). Larger = more aggressive bulge.
 *   radius — Gaussian sigma. Falloff is ~1% at 3·radius and ~0 at
 *            4·radius, so this is the spatial extent of the pull.
 *   lerp   — per-frame smoothing factor (0..1) between raw pointer
 *            target and rendered cursor position. Lower = laggier.
 *
 * On filled paths the boundary bulges toward the cursor. On stroked
 * paths the shader applies the same falloff to the *sausage* SDF
 * (`abs(d) - halfWidth`), which thickens and warps the ink near the
 * cursor — the "wet paint" model.
 */
export interface LiquidCursorParams {
  pull?: number;
  radius?: number;
  lerp?: number;
}

const DEFAULTS = {
  pull: 0.08,
  radius: 0.15,
  lerp: 0.5,
};

/** `(dx² + dy²)` below which we consider the smoothed cursor to have caught up. */
const REST_EPS_SQ = 1e-5;

/**
 * Pointer-follow liquid pull. Wires cursor position + pull strength
 * into shader uniforms; the fragment shader does the actual SDF
 * deformation. No per-frame rebake needed — the bake is once, the
 * sample is per-pixel, and the cursor falloff is added in the sampler.
 */
export const liquidCursor: EffectDefinition = {
  name: 'liquid-cursor',
  needsPointer: true,
  scrollTrigger: false,
  create({ reducedMotion, params }): EffectRuntime {
    if (reducedMotion) {
      return {
        frame: () => ({ cursorPull: 0 }),
        active: () => false,
      };
    }

    const initial = params as LiquidCursorParams | undefined;
    let pull = initial?.pull ?? DEFAULTS.pull;
    let radius = initial?.radius ?? DEFAULTS.radius;
    let lerp = initial?.lerp ?? DEFAULTS.lerp;

    let targetX = 0, targetY = 0;
    let smoothX = 0, smoothY = 0;
    let hoverPull = 0;

    return {
      frame() {
        smoothX += (targetX - smoothX) * lerp;
        smoothY += (targetY - smoothY) * lerp;
        return {
          cursor: [smoothX, smoothY],
          cursorPull: hoverPull,
          cursorRadius: radius,
        };
      },
      active() {
        if (hoverPull > 0) return true;
        const dx = targetX - smoothX;
        const dy = targetY - smoothY;
        return dx * dx + dy * dy > REST_EPS_SQ;
      },
      pointerMove(x, y) {
        targetX = x;
        targetY = y;
        hoverPull = pull;
      },
      pointerLeave() {
        hoverPull = 0;
      },
      pointerDown(x, y) {
        // Touch devices have no "hover" — without this handler, tapping
        // never engages the pull. On desktop this is redundant (a
        // pointermove at the same coords fired just before the down),
        // which is fine since it sets identical state.
        targetX = x;
        targetY = y;
        hoverPull = pull;
      },
      setParams(p) {
        const lp = p as LiquidCursorParams;
        if (typeof lp.pull === 'number') {
          pull = lp.pull;
          if (hoverPull > 0) hoverPull = pull;
        }
        if (typeof lp.radius === 'number') radius = lp.radius;
        if (typeof lp.lerp === 'number') lerp = lp.lerp;
      },
    };
  },
};
