import type { Mark, CubicSegment, Path } from './types';

export interface NormalizeOptions {
  /**
   * Target extent in normalized space. With `extent: 1`, the longest axis
   * spans exactly from `-1` to `+1`. Pass a smaller value to leave padding
   * around the mark for the renderer's bake region.
   * @default 0.95
   */
  extent?: number;

  /**
   * Flip the Y axis. Most SVG coordinate systems have `+y` pointing down;
   * the renderer expects `+y` up. Keep this `true` unless your input
   * already uses screen-up Y.
   * @default true
   */
  flipY?: boolean;
}

export interface NormalizedMark {
  mark: Mark;
  /** The transformation applied: translate by `offset`, scale by `scale`. */
  transform: {
    offsetX: number;
    offsetY: number;
    scale: number;
    flipY: boolean;
  };
}

/**
 * Center a mark on the origin and scale it so its longest axis fits the
 * requested extent. Returns the transformed mark plus the exact transform
 * used — handy if you need to map pointer events from canvas space back
 * into the original SVG's coordinate system.
 *
 * The bounding box is computed from segment endpoints only; control points
 * can bulge slightly outside the reported bbox but rarely matter for the
 * overall fit. If you trace shapes with wildly overshooting controls, bump
 * `extent` down a bit to leave headroom.
 */
export function normalizeMark(source: Mark, options: NormalizeOptions = {}): NormalizedMark {
  const { extent = 0.95, flipY = true } = options;

  // Compute bbox from endpoints (P0 and P3), expanded per-path by the
  // stroke half-width so stroked paths don't end up with their outer
  // edge outside the normalized target range (which would clip against
  // the canvas at zoom=1). Control points can lie slightly outside the
  // endpoint bbox but rarely extend the visible shape.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of source.paths) {
    const hw = path.mode === 'fill' ? 0 : path.strokeWidth * 0.5;
    let pMinX = Infinity, pMinY = Infinity, pMaxX = -Infinity, pMaxY = -Infinity;
    for (const seg of path.segments) {
      for (const i of [0, 6] as const) {
        const x = seg[i]!;
        const y = seg[i + 1]!;
        if (x < pMinX) pMinX = x;
        if (x > pMaxX) pMaxX = x;
        if (y < pMinY) pMinY = y;
        if (y > pMaxY) pMaxY = y;
      }
    }
    if (!isFinite(pMinX)) continue;
    if (pMinX - hw < minX) minX = pMinX - hw;
    if (pMaxX + hw > maxX) maxX = pMaxX + hw;
    if (pMinY - hw < minY) minY = pMinY - hw;
    if (pMaxY + hw > maxY) maxY = pMaxY + hw;
  }
  if (!isFinite(minX)) {
    // Empty mark — return unchanged to avoid NaN propagation. `source`
    // already carries any `renderMode` the caller set, so no copy needed.
    return {
      mark: source,
      transform: { offsetX: 0, offsetY: 0, scale: 1, flipY: false },
    };
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const halfW = (maxX - minX) / 2;
  const halfH = (maxY - minY) / 2;
  const maxHalf = Math.max(halfW, halfH) || 1; // avoid /0 on degenerate single-point marks
  const scale = extent / maxHalf;
  const ySign = flipY ? -1 : 1;

  const transform = (x: number, y: number): [number, number] => [
    (x - centerX) * scale,
    (y - centerY) * scale * ySign,
  ];

  const paths: Path[] = source.paths.map((path): Path => {
    const segments = path.segments.map((seg): CubicSegment => {
      const [p0x, p0y] = transform(seg[0]!, seg[1]!);
      const [p1x, p1y] = transform(seg[2]!, seg[3]!);
      const [p2x, p2y] = transform(seg[4]!, seg[5]!);
      const [p3x, p3y] = transform(seg[6]!, seg[7]!);
      return [p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y];
    });
    // Stroke width lives in the same coordinate system as the points, so
    // scaling the geometry means scaling the stroke by the same factor.
    // flipY affects orientation, never width, so it isn't applied here.
    return { ...path, segments, strokeWidth: path.strokeWidth * scale };
  });

  return {
    mark: { paths, renderMode: source.renderMode },
    transform: { offsetX: -centerX, offsetY: -centerY, scale, flipY },
  };
}
