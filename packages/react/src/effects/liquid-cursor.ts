import type { EffectDefinition, EffectRuntime } from './types';

/**
 * Tuning for the shader-side Gaussian cursor pull. Both values are in
 * normalized SDF space (the same coordinates the cursor lives in).
 *
 *   PULL   — peak SDF deformation at the cursor (subtracted from the
 *            sampled distance). Larger = more aggressive bulge.
 *   RADIUS — Gaussian sigma. Falloff is ~1% at 3·RADIUS and ~0 at
 *            4·RADIUS, so this is the spatial extent of the pull.
 *
 * On filled paths the boundary bulges toward the cursor. On stroked
 * paths the shader applies the same falloff to the *sausage* SDF
 * (`abs(d) - halfWidth`), which thickens and warps the ink near the
 * cursor — the "wet paint" model. Same params look slightly different
 * between modes; tune to taste, then leave alone.
 */
const PULL = 0.08;
const RADIUS = 0.15;
const POINTER_LERP = 0.5;

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
  create({ reducedMotion }): EffectRuntime {
    if (reducedMotion) {
      return {
        frame: () => ({ cursorPull: 0 }),
        active: () => false,
      };
    }

    let targetX = 0, targetY = 0;
    let smoothX = 0, smoothY = 0;
    let hoverPull = 0;

    return {
      frame() {
        smoothX += (targetX - smoothX) * POINTER_LERP;
        smoothY += (targetY - smoothY) * POINTER_LERP;
        return {
          cursor: [smoothX, smoothY],
          cursorPull: hoverPull,
          cursorRadius: RADIUS,
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
        hoverPull = PULL;
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
        hoverPull = PULL;
      },
    };
  },
};
