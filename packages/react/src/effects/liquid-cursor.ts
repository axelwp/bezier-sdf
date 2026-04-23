import type { EffectDefinition, EffectRuntime } from './types';

/**
 * Tuning lifted from examples/liquid-cursor. See that file's comments for
 * the physics — briefly: `cursorPull / cursorRadius` is the peak pull at
 * the cursor itself; it has to exceed typical SDF distances (~0.1–0.3) to
 * visibly reach out from the silhouette.
 */
const PULL_HOVER = 0.012;
const RADIUS = 0.05;
const POINTER_LERP = 0.5;

/** `(dx² + dy²)` below which we consider the smoothed cursor to have caught up. */
const REST_EPS_SQ = 1e-5;

/**
 * Pointer-follow liquid-metal pull. The silhouette's zero-contour bulges
 * toward the cursor; drag it inward and the shape fuses with the pointer.
 * When the cursor leaves, the pull fades and the smoothing tail settles.
 */
export const liquidCursor: EffectDefinition = {
  name: 'liquid-cursor',
  needsPointer: true,
  scrollTrigger: false,
  create({ reducedMotion }): EffectRuntime {
    if (reducedMotion) {
      // No pull, no motion — silhouette renders flat.
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
        hoverPull = PULL_HOVER;
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
        hoverPull = PULL_HOVER;
      },
    };
  },
};
