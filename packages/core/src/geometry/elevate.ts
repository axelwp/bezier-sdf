import type { CubicSegment } from './types';

/**
 * Lines and quadratics expressed exactly as the package's cubic segment
 * format. Shared by the SVG path parser and the tree generator.
 */

export function lineAsCubic(x0: number, y0: number, x: number, y: number): CubicSegment {
  // A degenerate cubic along a straight line — controls at 1/3 and 2/3.
  // The renderer treats these like any other cubic; the Newton refinement
  // converges trivially since the derivative is constant.
  const c1x = x0 + (x - x0) / 3;
  const c1y = y0 + (y - y0) / 3;
  const c2x = x0 + (2 * (x - x0)) / 3;
  const c2y = y0 + (2 * (y - y0)) / 3;
  return [x0, y0, c1x, c1y, c2x, c2y, x, y];
}

export function quadAsCubic(
  x0: number, y0: number,
  qx: number, qy: number,
  x: number,  y: number,
): CubicSegment {
  // Elevate a quadratic (P0, Q, P1) to a cubic (P0, C1, C2, P1) where
  //   C1 = P0 + 2/3 * (Q - P0)
  //   C2 = P1 + 2/3 * (Q - P1)
  // This is the standard degree-elevation formula; the resulting cubic
  // traces the exact same curve as the quadratic.
  const c1x = x0 + (2 / 3) * (qx - x0);
  const c1y = y0 + (2 / 3) * (qy - y0);
  const c2x = x  + (2 / 3) * (qx - x);
  const c2y = y  + (2 / 3) * (qy - y);
  return [x0, y0, c1x, c1y, c2x, c2y, x, y];
}
