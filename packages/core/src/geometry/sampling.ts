import type { Path, CubicSegment } from './types';

/**
 * Sample `count` points along a path, evenly spaced by segment parameter
 * (not by arc length). Returns a flat Float32Array of `[x0, y0, x1, y1, …]`.
 *
 * Segments in hand-traced logos are typically similar in arc length, so
 * parameter-spaced samples read as visually uniform. If your path has
 * wildly varying segment lengths and you need true arc-length parameter-
 * ization, sample at higher density and resample.
 *
 * Useful for:
 *   - Morphing between two shapes: sample each at the same `count`, then
 *     linearly interpolate corresponding indices.
 *   - Drawing a path as a polyline that can tween from some other source
 *     (a chart, a sine wave, a straight line) into the shape.
 *   - Positioning elements along a path (particles, dots, labels).
 *
 * @param path Source path.
 * @param count Number of points to sample. Must be >= 2.
 * @returns A Float32Array of length `count * 2` in `[x, y, x, y, ...]` order.
 */
export function sampleBezierPath(path: Path, count: number): Float32Array {
  if (count < 2) {
    throw new RangeError(`sampleBezierPath: count must be >= 2, got ${count}`);
  }
  const segs = path.segments;
  if (segs.length === 0) {
    return new Float32Array(count * 2);
  }
  const pts = new Float32Array(count * 2);
  const nSegs = segs.length;

  for (let i = 0; i < count; i++) {
    // `fidx` maps [0, count-1] to [0, nSegs], so i=0 lands on segment 0
    // start and i=count-1 lands on segment (nSegs-1) end.
    const fidx = (i / (count - 1)) * nSegs;
    const segIdx = Math.min(nSegs - 1, Math.floor(fidx));
    const t = Math.min(1, fidx - segIdx);
    const seg = segs[segIdx]!;

    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    const b0 = mt2 * mt;
    const b1 = 3 * mt2 * t;
    const b2 = 3 * mt * t2;
    const b3 = t2 * t;

    pts[i * 2]     = b0 * seg[0]! + b1 * seg[2]! + b2 * seg[4]! + b3 * seg[6]!;
    pts[i * 2 + 1] = b0 * seg[1]! + b1 * seg[3]! + b2 * seg[5]! + b3 * seg[7]!;
  }

  return pts;
}

/**
 * Evaluate a single cubic Bezier segment at parameter `t` in `[0, 1]`.
 * Handy for drawing a moving marker along a path — feed it a fractional
 * segment index and the remainder.
 */
export function evalCubic(
  seg: CubicSegment,
  t: number,
): [number, number] {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return [
    mt2 * mt * seg[0]! + 3 * mt2 * t * seg[2]! + 3 * mt * t2 * seg[4]! + t2 * t * seg[6]!,
    mt2 * mt * seg[1]! + 3 * mt2 * t * seg[3]! + 3 * mt * t2 * seg[5]! + t2 * t * seg[7]!,
  ];
}
