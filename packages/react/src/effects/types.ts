/**
 * An effect is a small stateful runtime the component drives each frame.
 *
 * `reveal` is time-based: elapsed ms since `replay()` → frame. `ripple` and
 * `liquid-cursor` are event-driven: a pointer moved, a click happened, and
 * the frame reflects that state. Wrapping both in one interface keeps the
 * component's uniform-merging loop trivial — it doesn't care which shape
 * of effect is active, only what fields the frame filled in.
 */

export interface EffectFrame {
  /** Overlay for per-path SDF offsets; length must match `pathCount`. */
  pathOffsets?: ReadonlyArray<readonly [number, number]>;
  /** Overlay opacity in 0..1. */
  opacity?: number;
  /** Overlay sminK (soft-union radius). */
  sminK?: number;
  /** Cursor position in SDF space (`[-1, 1]`). */
  cursor?: readonly [number, number];
  /** Pull strength at `cursor`. See core `Uniforms.cursorPull`. */
  cursorPull?: number;
  /** Softening epsilon for the pull field. See core `Uniforms.cursorRadius`. */
  cursorRadius?: number;
  /** Active ripple rings. See core `Uniforms.ripples`. */
  ripples?: ReadonlyArray<readonly [number, number, number, number]>;
}

export interface EffectRuntime {
  /** Frame for `now` (ms since `performance.timeOrigin`). */
  frame(now: number): EffectFrame;
  /**
   * Should rAF keep pumping after this frame? Returning `false` lets the
   * component freeze on the last emitted frame until an event (pointer,
   * replay, intersection) nudges it back on.
   */
  active(now: number): boolean;
  /** Pointer moved over the canvas. `x`/`y` in SDF space. */
  pointerMove?(x: number, y: number, now: number): void;
  /** Pointer left the canvas. */
  pointerLeave?(now: number): void;
  /** Pointer pressed on the canvas. `x`/`y` in SDF space. */
  pointerDown?(x: number, y: number, now: number): void;
  /**
   * Reset the effect to its pre-trigger state (for reveal, re-plays from
   * the split-out pose; a no-op for purely reactive effects).
   */
  replay?(now: number): void;
  /**
   * Live-update tuning without tearing down the runtime. Each effect
   * accepts its own param shape; unknown keys are ignored.
   */
  setParams?(params: Record<string, number>): void;
}

export interface EffectCreateOptions {
  pathCount: number;
  reducedMotion: boolean;
  /** Forwarded from the component prop — only `reveal` uses it. */
  autoPlay: boolean;
  /** Initial tuning. Effect-specific; each effect casts its own shape. */
  params?: Record<string, number>;
}

export interface EffectDefinition {
  readonly name: string;
  /** If `true`, the component attaches `pointer*` listeners to the canvas. */
  readonly needsPointer: boolean;
  /**
   * If `true`, the component waits for the element to scroll into view
   * before calling `runtime.replay()` to kick off the animation. `autoPlay`
   * and `prefers-reduced-motion` both bypass this gate.
   */
  readonly scrollTrigger: boolean;
  create(opts: EffectCreateOptions): EffectRuntime;
}
