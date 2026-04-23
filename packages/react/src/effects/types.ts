/**
 * An Effect is a pure function from elapsed time to a partial uniforms
 * overlay. The component owns the base uniforms (all pathOffsets zero,
 * opacity 1, sminK 0.08) and merges the effect's frame on top each tick.
 *
 * Kept deliberately minimal. Future effects (ripple, liquid-cursor, morph)
 * will need richer inputs — pointer position, ripple events, a second mark.
 * When that happens, widen `EffectContext` rather than changing this
 * interface's call shape; callers of `at` and `initial` won't have to move.
 */

export interface EffectFrame {
  /** Overlay for per-path screen offsets; length must match pathCount. */
  pathOffsets?: ReadonlyArray<readonly [number, number]>;
  /** Overlay opacity in 0..1. */
  opacity?: number;
  /** Overlay sminK (soft-union radius). */
  sminK?: number;
  /** When true, the component stops the rAF loop and freezes at this frame. */
  done: boolean;
}

export interface Effect {
  readonly name: string;
  /** Total animation length in ms. `at(durationMs)` should return `done: true`. */
  readonly durationMs: number;
  /**
   * State shown *before* the effect is triggered — e.g. the pre-reveal
   * split-out position, or the zero-opacity start for a fade-in. Lets the
   * component render a stable "poised" frame while waiting for scroll-in.
   */
  initial(pathCount: number): EffectFrame;
  /** State at the given elapsed time in ms since the effect started. */
  at(elapsed: number, pathCount: number): EffectFrame;
}
