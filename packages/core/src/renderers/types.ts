import type { Mark, Path, PathMode, RgbColor } from '../geometry/types';

/**
 * Per-frame uniforms. The mark itself is baked once at init time; only
 * camera/color/animation state updates each frame.
 *
 * Two composition modes, selected by the renderer based on the Uniforms
 * the caller provides:
 *
 *   - **Legacy smin mode** (used by the reveal example): pass `color`
 *     alone and leave the per-path fields unset. All paths are smooth-
 *     unioned into a single silhouette painted with `color`. `sminK`
 *     controls the soft-union radius.
 *
 *   - **Per-path composite mode** (used for arbitrary user SVGs): pass
 *     `pathModes`, `pathFillColors`, `pathStrokeColors`, `pathStrokeHalfW`.
 *     Each path is rasterized independently (fill, stroke, or both) and
 *     composited in document order. smin is not applied across paths in
 *     this mode — see `KNOWN_LIMITATIONS.md`.
 *
 * `pathOffsets` translates each sub-path's UV before the SDF lookup —
 * the animation primitive. A path at offset `(0, 0)` is drawn in its
 * baked position; at `(0.3, 0)` it slides right by 30% of normalized
 * space. Length of the array must match the number of paths baked at
 * init time.
 *
 * `cursor` / `cursorPull` / `cursorRadius` subtract an inverse-square
 * radial field `cursorPull / (|cursor - uv|² + cursorRadius)` from each
 * sampled distance before silhouette resolution — applies in both
 * composition modes.
 *
 * `ripples` is an array of up to 4 concurrent Gaussian shockwave rings.
 * Each entry is `[x, y, age, amplitude]`. Applies in both modes.
 */
export interface Uniforms {
  width: number;
  height: number;
  zoom: number;
  sminK: number;
  offsetX: number;
  offsetY: number;
  pathOffsets: ReadonlyArray<readonly [number, number]>;
  /** Legacy-mode global color. Ignored in per-path composite mode. */
  color: readonly [number, number, number];
  opacity: number;
  cursor?: readonly [number, number];
  cursorPull?: number;
  cursorRadius?: number;
  ripples?: ReadonlyArray<readonly [number, number, number, number]>;

  /** Opt into per-path composite mode by passing any of the arrays below. */
  pathModes?: ReadonlyArray<PathMode>;
  pathStrokeHalfW?: ReadonlyArray<number>;
  pathFillColors?: ReadonlyArray<RgbColor>;
  pathStrokeColors?: ReadonlyArray<RgbColor>;
  pathFillOpacity?: ReadonlyArray<number>;
  pathStrokeOpacity?: ReadonlyArray<number>;

  /**
   * Switch the render to the liquid-glass (refractive material) sample
   * pipeline. Requires the renderer to have been init'd with a
   * {@link RendererInitOptions.backdrop}; otherwise the glass pipeline
   * isn't available and this flag is ignored.
   *
   * Glass is a material, not a painter: per-path colors, strokes,
   * `color`, and animation offsets are ignored. All paths smooth-union
   * into one silhouette used as the lens shape.
   */
  glass?: boolean;
  /** See liquid-glass params in the shader. Defaults applied if omitted. */
  refractionStrength?: number;
  chromaticStrength?: number;
  fresnelStrength?: number;
  tintStrength?: number;
  /** Radius (in physical pixels) of the box-ish blur applied across the
   *  interior to give the backdrop a frosted quality. `0` disables. */
  frostStrength?: number;
  rimColor?: readonly [number, number, number];
  tintColor?: readonly [number, number, number];
}

export interface RendererInitOptions {
  canvas: HTMLCanvasElement;
  mark: Mark;
  /**
   * Image to refract through the shape when rendering in liquid-glass
   * mode. Uploaded once at init. Must be same-origin or served with
   * appropriate CORS headers, otherwise texture upload will throw a
   * security error.
   *
   * If provided, the renderer compiles the glass sample pipeline
   * alongside the normal one; the caller decides per-frame which to use
   * via {@link Uniforms.glass}. Prototype: static only — dynamic
   * backdrops (video, updating canvas) need a re-init.
   */
  backdrop?: TexImageSource;
}

export interface Renderer {
  readonly kind: 'webgpu' | 'webgl';
  readonly mode: 'baked' | 'direct';
  /** Number of paths available to be offset individually. */
  readonly pathCount: number;
  init(options: RendererInitOptions): Promise<void>;
  render(uniforms: Uniforms): void;
  /**
   * Re-run the bake pass with new geometry, writing into the existing
   * SDF textures. Used by geometry-distortion effects (e.g. liquid-cursor
   * on stroked marks) that need the underlying curves to bend rather than
   * the sampled distance to shift.
   *
   * The mark's structural shape — number of paths, paint metadata — must
   * match what was passed to {@link init}; only segment positions should
   * differ. Segment counts may differ as long as they stay under the
   * backend's MAX_SEGS. No GPU resources are allocated; only segment data
   * is uploaded and the bake pipeline is re-run.
   *
   * Optional: backends without a baking step (the WebGL `direct` mode)
   * may treat this as a no-op. Callers should not rely on rebake outside
   * `mode === 'baked'`.
   */
  rebake(mark: Mark): void;
  dispose(): void;
}

/** Validation helper used by both renderers. */
export function validateMark(mark: Mark, maxPaths: number, maxSegsPerPath: number): void {
  if (mark.paths.length === 0) {
    throw new Error('mark must contain at least one path');
  }
  if (mark.paths.length > maxPaths) {
    throw new Error(
      `mark has ${mark.paths.length} paths but this renderer supports at most ${maxPaths}. ` +
        'Merge smaller paths together, or file a feature request.',
    );
  }
  for (let i = 0; i < mark.paths.length; i++) {
    const p: Path = mark.paths[i]!;
    if (p.segments.length > maxSegsPerPath) {
      throw new Error(
        `path[${i}] has ${p.segments.length} segments but the shader's MAX_SEGS is ${maxSegsPerPath}. ` +
          'Simplify the trace in Inkscape (Path → Simplify) or raise MAX_SEGS in shaders/webgl.ts.',
      );
    }
  }
}
