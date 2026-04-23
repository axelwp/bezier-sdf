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
}

export interface RendererInitOptions {
  canvas: HTMLCanvasElement;
  mark: Mark;
}

export interface Renderer {
  readonly kind: 'webgpu' | 'webgl';
  readonly mode: 'baked' | 'direct';
  /** Number of paths available to be offset individually. */
  readonly pathCount: number;
  init(options: RendererInitOptions): Promise<void>;
  render(uniforms: Uniforms): void;
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
