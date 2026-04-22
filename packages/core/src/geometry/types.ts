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
 * A sequence of connected cubic segments forming a closed outline. The
 * last segment's `P3` should equal the first segment's `P0` so the path
 * closes cleanly — the renderer uses this assumption when computing
 * ray-crossings for inside/outside tests.
 */
export type Path = readonly CubicSegment[];

/**
 * A full mark — one or more paths that together make up a logo. The
 * split-morph animation treats each path as an independent sub-shape
 * with its own baked SDF texture. Single-path marks are fine too.
 */
export interface Mark {
  readonly paths: readonly Path[];
}

/** Convenience: wrap one or more paths in a {@link Mark}. */
export function mark(...paths: Path[]): Mark {
  return { paths };
}
