/**
 * Canvas 2D helpers that consume the same {@link Mark} geometry as the
 * GPU renderers. Useful for effects where per-pixel control is easier
 * than shader work — particle systems masked by the silhouette, animated
 * outlines, text layered inside the shape, etc.
 *
 * These helpers are *independent* of the SDF renderer. You can use them
 * in a page with no WebGL/WebGPU at all.
 */

import type { CubicSegment, Mark, Path } from '../geometry/types';

/**
 * A function that maps a point in normalized logo space to canvas pixel
 * space. Returned by {@link makeTransform}.
 */
export type ToCanvas = (x: number, y: number) => [number, number];

/**
 * Build a transform function that maps logo-space coordinates to canvas
 * pixel coordinates. Matches the SDF renderer's convention: the logo's
 * `[-1, 1]` box fits centered in the shortest canvas dimension at
 * `zoom === 1`.
 */
export function makeTransform(width: number, height: number, zoom = 1.0): ToCanvas {
  const scale = (Math.min(width, height) / 2) * zoom;
  return (x, y) => [width / 2 + x * scale, height / 2 - y * scale];
}

/**
 * Build a `Path2D` from a path of cubic segments. Closes the path with
 * `closePath()`; assumes the geometry is already a closed outline.
 */
export function buildPath2D(path: Path, toCanvas: ToCanvas): Path2D {
  const p2d = new Path2D();
  const first = path[0];
  if (!first) return p2d;
  const [sx, sy] = toCanvas(first[0]!, first[1]!);
  p2d.moveTo(sx, sy);
  for (const seg of path) {
    const [c1x, c1y] = toCanvas(seg[2]!, seg[3]!);
    const [c2x, c2y] = toCanvas(seg[4]!, seg[5]!);
    const [ex, ey]   = toCanvas(seg[6]!, seg[7]!);
    p2d.bezierCurveTo(c1x, c1y, c2x, c2y, ex, ey);
  }
  p2d.closePath();
  return p2d;
}

export interface BuiltMark {
  /** One `Path2D` per path in the mark, in original order. */
  paths: Path2D[];
  /** All paths merged into a single `Path2D` — convenient for clipping. */
  combined: Path2D;
  toCanvas: ToCanvas;
}

/** Build `Path2D` objects for every path in a mark plus a combined one. */
export function buildMark(mark: Mark, width: number, height: number, zoom = 1.0): BuiltMark {
  const toCanvas = makeTransform(width, height, zoom);
  const paths = mark.paths.map((p) => buildPath2D(p, toCanvas));
  const combined = new Path2D();
  for (const p of paths) combined.addPath(p);
  return { paths, combined, toCanvas };
}

/**
 * Rasterize a mark into a raw RGBA pixel buffer where the silhouette is
 * filled white. Useful as a per-pixel mask for effects that want to test
 * "is this pixel inside the logo" without evaluating the SDF — e.g.
 * particle systems that spawn inside the shape, or text overlays.
 */
export function buildMaskPixels(
  mark: Mark,
  width: number,
  height: number,
  zoom = 1.0,
): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) return new Uint8ClampedArray(width * height * 4);
  const built = buildMark(mark, width, height, zoom);
  ctx.fillStyle = '#fff';
  for (const p of built.paths) ctx.fill(p);
  return ctx.getImageData(0, 0, width, height).data;
}

/* ----------------------------- Perturbation ------------------------------ */

/**
 * State for {@link perturbPath} — describes how the control points of a
 * path wobble over time.
 *
 *   amp    — maximum control-point displacement in logo-space units.
 *   freq1, freq2 — two oscillation frequencies (radians / ms) for the
 *                  two axes of wobble. Keeping them coprime makes the
 *                  motion non-repeating over short timescales.
 *   phase1, phase2 — phase offsets so multiple paths can breathe out of
 *                    sync with each other.
 *
 * Generate one of these per path with a deterministic RNG for reproduc-
 * ible animations.
 */
export interface PerturbSeed {
  amp: number;
  freq1: number;
  freq2: number;
  phase1: number;
  phase2: number;
}

/**
 * Trace a perturbed version of a path onto a 2D canvas context. Each
 * segment's *control* points are offset by a time-varying displacement
 * that combines two sinusoids; the *endpoints* (anchors) are left in
 * place so adjacent segments remain joined exactly — no gaps, no visible
 * discontinuities.
 *
 * This is the "breathing outline" primitive that powers the Fan variant
 * and the settle-and-hold phase of the chart-to-logo morph: a mark can
 * wobble gently as if alive, without the anchor drift that plagues naive
 * noise-displacement approaches.
 *
 * Caller owns `beginPath()` / `stroke()` — this only emits `moveTo` +
 * `bezierCurveTo` + `closePath` on the given context. Run the same
 * seed's trace inside any stroke/fill style you like.
 *
 * @param ctx         2D context to trace on.
 * @param path        Source segments in logo space.
 * @param toCanvas    Coordinate transform (from {@link makeTransform}).
 * @param seed        Per-path wobble configuration.
 * @param timeMs      Current animation time in milliseconds.
 * @param extraPhase  Additional phase offset (useful for second/third
 *                    paths in the same mark so they don't all breathe
 *                    in unison). Pass 0 if you want identical motion.
 */
export function perturbPath(
  ctx: CanvasRenderingContext2D,
  path: Path,
  toCanvas: ToCanvas,
  seed: PerturbSeed,
  timeMs: number,
  extraPhase = 0,
): void {
  if (path.length === 0) return;
  const osc1 = Math.sin(timeMs * seed.freq1 + seed.phase1 + extraPhase);
  const osc2 = Math.sin(timeMs * seed.freq2 + seed.phase2 + extraPhase);
  const amp = seed.amp;

  const first: CubicSegment = path[0]!;
  const [sx, sy] = toCanvas(first[0]!, first[1]!);
  ctx.moveTo(sx, sy);

  for (let k = 0; k < path.length; k++) {
    const s: CubicSegment = path[k]!;
    // Per-segment phase adjustments so each segment's controls wobble
    // somewhat independently; keeps the perturbation from looking like
    // uniform "wind" pushing the whole shape in one direction.
    const dx1 = amp * osc1 * Math.sin(k * 1.37 + seed.phase1 + extraPhase);
    const dy1 = amp * osc2 * Math.cos(k * 1.11 + seed.phase1 + extraPhase);
    const dx2 = amp * osc2 * Math.sin(k * 0.89 + seed.phase2 + extraPhase);
    const dy2 = amp * osc1 * Math.cos(k * 1.53 + seed.phase2 + extraPhase);

    const [c1x, c1y] = toCanvas(s[2]! + dx1, s[3]! + dy1);
    const [c2x, c2y] = toCanvas(s[4]! + dx2, s[5]! + dy2);
    const [ex, ey]   = toCanvas(s[6]!,       s[7]!);
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, ex, ey);
  }
  ctx.closePath();
}
