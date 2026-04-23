import type { Mark, Path } from '../geometry/types';

/**
 * Per-frame uniforms. The mark itself is baked once at init time; only
 * camera/color/animation state updates each frame.
 *
 * `pathOffsets` translates each sub-path's UV before the SDF lookup —
 * the animation primitive. A path at offset `(0, 0)` is drawn in its
 * baked position; at `(0.3, 0)` it slides right by 30% of normalized
 * space. Length of the array must match the number of paths baked at
 * init time.
 *
 * `sminK` controls the soft-union rounding radius when multiple paths
 * overlap. Large `sminK` (say 0.1+) produces a "fluid metal" bridge
 * between adjacent paths; small `sminK` (< 0.02) collapses to a plain
 * union.
 *
 * `cursor` / `cursorPull` / `cursorRadius` subtract an inverse-square
 * radial field `cursorPull / (|cursor - uv|² + cursorRadius)` from the
 * scene SDF. The local reduction bulges the silhouette's zero-contour
 * outward toward `cursor` and fuses with it when close — liquid-metal
 * attraction. `cursorPull = 0` (the default) is a no-op. `cursorRadius`
 * is a softening epsilon (smaller = sharper, narrower tendril; typical
 * range 0.01–0.1 in normalized SDF space). Existing callers don't need
 * to set these.
 *
 * `ripples` is an array of up to 4 concurrent Gaussian shockwave rings.
 * Each entry is `[x, y, age, amplitude]` where (x,y) is the ring
 * center in SDF space, `age` is the ring's current radius (grow it
 * over time from JS), and `amplitude` is its height (taper to zero to
 * fade). Slots with `amplitude = 0` are no-ops. Omit the field or pass
 * an empty array to disable ripples entirely.
 */
export interface Uniforms {
  width: number;
  height: number;
  zoom: number;
  sminK: number;
  offsetX: number;
  offsetY: number;
  pathOffsets: ReadonlyArray<readonly [number, number]>;
  color: readonly [number, number, number];
  opacity: number;
  cursor?: readonly [number, number];
  cursorPull?: number;
  cursorRadius?: number;
  ripples?: ReadonlyArray<readonly [number, number, number, number]>;
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
    if (p.length > maxSegsPerPath) {
      throw new Error(
        `path[${i}] has ${p.length} segments but the shader's MAX_SEGS is ${maxSegsPerPath}. ` +
          'Simplify the trace in Inkscape (Path → Simplify) or raise MAX_SEGS in shaders/webgl.ts.',
      );
    }
  }
}
