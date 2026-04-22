import type { Mark, CubicSegment } from './types';

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

  // Compute bbox from endpoints (P0 and P3). Control points can lie
  // slightly outside; in practice they rarely extend the visible shape.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of source.paths) {
    for (const seg of path) {
      for (const i of [0, 6] as const) {
        const x = seg[i]!;
        const y = seg[i + 1]!;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!isFinite(minX)) {
    // Empty mark — return unchanged to avoid NaN propagation.
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

  const paths = source.paths.map((path) =>
    path.map((seg): CubicSegment => {
      const [p0x, p0y] = transform(seg[0]!, seg[1]!);
      const [p1x, p1y] = transform(seg[2]!, seg[3]!);
      const [p2x, p2y] = transform(seg[4]!, seg[5]!);
      const [p3x, p3y] = transform(seg[6]!, seg[7]!);
      return [p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y];
    }),
  );

  return {
    mark: { paths },
    transform: { offsetX: -centerX, offsetY: -centerY, scale, flipY },
  };
}
