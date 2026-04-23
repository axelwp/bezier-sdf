/**
 * A single cubic Bezier segment stored as a flat 8-tuple:
 *
 *   [P0.x, P0.y, P1.x, P1.y, P2.x, P2.y, P3.x, P3.y]
 *
 * `P0` and `P3` are the segment's endpoints; `P1` and `P2` are the two
 * control points. Coordinates live in a symmetric "logo space" centered
 * at the origin, with `+y` pointing up. The convention `|x|, |y| ≲ 1`
 * keeps the shape within the default bake region (see `BAKE_BOUND`).
 *
 * This flat layout matches the fragment-shader uniform packing (two vec4s
 * per segment) and avoids allocating nested arrays on every frame.
 */
export type CubicSegment = readonly [
  number, number, // P0 — segment start
  number, number, // P1 — first control point
  number, number, // P2 — second control point
  number, number, // P3 — segment end
];

/**
 * How a {@link Path} should be painted.
 *
 *   'fill'   — rasterize where the signed distance is < 0 (the interior
 *              of a closed outline).
 *   'stroke' — rasterize where `|d| < strokeWidth / 2` (a ring along the
 *              curve). Works even on open paths.
 *   'both'   — paint fill first, then stroke on top. Emitted when an SVG
 *              `<path>` has both a `fill` and a `stroke` attribute set.
 */
export type PathMode = 'fill' | 'stroke' | 'both';

/** sRGB triple in 0..1. */
export type RgbColor = readonly [number, number, number];

/**
 * A single sub-shape of a mark: a sequence of connected cubic segments
 * plus the paint metadata that says how to render it.
 *
 * For `mode: 'fill'` (or `'both'`), the last segment's `P3` should equal
 * the first segment's `P0` so the inside/outside test is well-defined.
 * Stroke mode has no such requirement — open paths stroke correctly.
 *
 * Colors are sRGB 0..1; opacities are 0..1 and multiply with the caller-
 * supplied global `opacity`. `strokeWidth` is in the same coordinate
 * system as the segments — {@link normalizeMark} scales it alongside
 * the geometry.
 */
export interface Path {
  readonly segments: readonly CubicSegment[];
  readonly mode: PathMode;
  readonly strokeWidth: number;
  readonly fillColor: RgbColor;
  readonly strokeColor: RgbColor;
  readonly fillOpacity: number;
  readonly strokeOpacity: number;
}

/**
 * A full mark — one or more paths that together make up a logo. The
 * split-morph animation treats each path as an independent sub-shape
 * with its own baked SDF texture. Single-path marks are fine too.
 */
export interface Mark {
  readonly paths: readonly Path[];
}

/**
 * Construct a {@link Path} with sensible defaults for the metadata
 * fields. Only `segments` is required; everything else falls back to
 * "solid black fill."
 */
export function makePath(
  segments: readonly CubicSegment[],
  opts: Partial<Omit<Path, 'segments'>> = {},
): Path {
  return {
    segments,
    mode: opts.mode ?? 'fill',
    strokeWidth: opts.strokeWidth ?? 0,
    fillColor: opts.fillColor ?? [0, 0, 0],
    strokeColor: opts.strokeColor ?? [0, 0, 0],
    fillOpacity: opts.fillOpacity ?? 1,
    strokeOpacity: opts.strokeOpacity ?? 1,
  };
}

/** Convenience: wrap one or more paths in a {@link Mark}. */
export function mark(...paths: Path[]): Mark {
  return { paths };
}
