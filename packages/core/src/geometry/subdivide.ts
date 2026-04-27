import type { CubicSegment, Mark, Path } from './types';

/**
 * de Casteljau split of a cubic Bezier at `t = 0.5`. Returns two cubics
 * whose union exactly retraces the original — no curve approximation,
 * just a re-parameterization. Used to densify long segments before
 * geometry-distortion effects so a cursor hovering between control
 * points still finds nearby points to pull.
 */
export function splitCubic(seg: CubicSegment): [CubicSegment, CubicSegment] {
  const [p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y] = seg;
  const m01x = (p0x + p1x) * 0.5, m01y = (p0y + p1y) * 0.5;
  const m12x = (p1x + p2x) * 0.5, m12y = (p1y + p2y) * 0.5;
  const m23x = (p2x + p3x) * 0.5, m23y = (p2y + p3y) * 0.5;
  const m012x = (m01x + m12x) * 0.5, m012y = (m01y + m12y) * 0.5;
  const m123x = (m12x + m23x) * 0.5, m123y = (m12y + m23y) * 0.5;
  const mx = (m012x + m123x) * 0.5, my = (m012y + m123y) * 0.5;
  return [
    [p0x, p0y, m01x, m01y, m012x, m012y, mx, my],
    [mx, my, m123x, m123y, m23x, m23y, p3x, p3y],
  ];
}

/**
 * Endpoint-to-endpoint distance — a cheap lower bound on a cubic's true
 * arc length. Good enough for "is this segment long enough to need
 * subdivision?" decisions; we don't need precise length.
 */
export function chordLength(seg: CubicSegment): number {
  const dx = seg[6] - seg[0];
  const dy = seg[7] - seg[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Recursively subdivide cubics in `path` until each segment's chord
 * length is at most `threshold`. Doubles segment count on each split,
 * so a 14-segment path with threshold 0.15 typically lands around 28-50
 * segments. Pure function; original path unchanged.
 *
 * If subdivision would push past `maxSegments`, returns the partially-
 * subdivided result and the caller can decide whether to warn. The
 * remaining over-threshold segments stay in place — better to render an
 * imperfectly-bendy long segment than to exceed the renderer's per-path
 * cap.
 */
export function subdividePath(
  path: Path,
  threshold: number,
  maxSegments: number,
): { path: Path; truncated: boolean } {
  let segs: CubicSegment[] = path.segments.slice() as CubicSegment[];
  let changed = true;
  let truncated = false;
  while (changed) {
    changed = false;
    const out: CubicSegment[] = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      if (chordLength(s) <= threshold) {
        out.push(s);
        continue;
      }
      // Would splitting overflow the cap? Worst-case sizing: this split
      // adds 1 net segment, plus the unprocessed tail still needs room.
      const projected = out.length + 2 + (segs.length - i - 1);
      if (projected > maxSegments) {
        truncated = true;
        out.push(s);
        continue;
      }
      const [a, b] = splitCubic(s);
      out.push(a, b);
      changed = true;
    }
    segs = out;
  }
  return { path: { ...path, segments: segs }, truncated };
}

/**
 * Subdivide every path in a mark, capping per-path segment count at
 * `maxSegmentsPerPath` (matches the renderer's per-path cap). Logs a
 * single console warning if any path was truncated mid-subdivision;
 * returns the new mark plus a `truncated` flag so callers can suppress
 * the warning when not desired.
 */
export function subdivideMark(
  mark: Mark,
  threshold: number,
  maxSegmentsPerPath: number,
): { mark: Mark; truncated: boolean } {
  let anyTruncated = false;
  const paths: Path[] = mark.paths.map((p) => {
    const { path, truncated } = subdividePath(p, threshold, maxSegmentsPerPath);
    if (truncated) anyTruncated = true;
    return path;
  });
  return { mark: { paths }, truncated: anyTruncated };
}
