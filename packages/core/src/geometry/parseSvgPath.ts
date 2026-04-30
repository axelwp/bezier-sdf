import { type CubicSegment, type Mark, makePath } from './types';

/**
 * Parse an SVG path data string into one or more {@link Path}s of cubic
 * Bezier segments.
 *
 * Supports the commands most commonly emitted by Inkscape, Figma, and
 * Illustrator when exporting "Plain SVG":
 *
 *   M / m — moveto (starts a new subpath)
 *   L / l — lineto (converted to a degenerate cubic)
 *   H / h — horizontal lineto (converted)
 *   V / v — vertical lineto (converted)
 *   C / c — cubic Bezier
 *   S / s — smooth cubic (reflects previous control point)
 *   Q / q — quadratic Bezier (elevated to cubic)
 *   T / t — smooth quadratic (elevated)
 *   A / a — elliptical arc (approximated by cubics, ≤ 90° per segment)
 *   Z / z — closepath
 *
 * All coordinates come through unchanged; see {@link normalizeMark} to
 * fit them into the renderer's expected `[-1, 1]` space.
 */
export function parseSvgPath(d: string): Mark {
  const tokens = tokenize(d);
  const state: ParserState = {
    tokens,
    index: 0,
    cx: 0,
    cy: 0,
    startX: 0,
    startY: 0,
    lastCubicC2: null,
    lastQuadC1: null,
  };

  const paths: CubicSegment[][] = [];
  let current: CubicSegment[] | null = null;
  let cmd: string | null = null;

  while (state.index < tokens.length) {
    const tok = tokens[state.index]!;
    if (isCommand(tok)) {
      cmd = tok;
      state.index += 1;
    } else if (cmd === null) {
      throw new SyntaxError(`path must start with a command, got ${tok}`);
    }

    switch (cmd) {
      case 'M':
      case 'm': {
        const [x, y] = readPoint(state, cmd === 'm');
        state.cx = x;
        state.cy = y;
        state.startX = x;
        state.startY = y;
        current = [];
        paths.push(current);
        // subsequent coordinates after M/m are implicit L/l
        cmd = cmd === 'm' ? 'l' : 'L';
        break;
      }
      case 'L':
      case 'l': {
        if (!current) throw new SyntaxError('L before M');
        const [x, y] = readPoint(state, cmd === 'l');
        current.push(lineAsCubic(state.cx, state.cy, x, y));
        state.cx = x;
        state.cy = y;
        state.lastCubicC2 = null;
        state.lastQuadC1 = null;
        break;
      }
      case 'H':
      case 'h': {
        if (!current) throw new SyntaxError('H before M');
        let x = parseFloat(consume(state));
        if (cmd === 'h') x += state.cx;
        current.push(lineAsCubic(state.cx, state.cy, x, state.cy));
        state.cx = x;
        state.lastCubicC2 = null;
        state.lastQuadC1 = null;
        break;
      }
      case 'V':
      case 'v': {
        if (!current) throw new SyntaxError('V before M');
        let y = parseFloat(consume(state));
        if (cmd === 'v') y += state.cy;
        current.push(lineAsCubic(state.cx, state.cy, state.cx, y));
        state.cy = y;
        state.lastCubicC2 = null;
        state.lastQuadC1 = null;
        break;
      }
      case 'C':
      case 'c': {
        if (!current) throw new SyntaxError('C before M');
        const [c1x, c1y] = readPoint(state, cmd === 'c');
        const [c2x, c2y] = readPoint(state, cmd === 'c');
        const [x,   y  ] = readPoint(state, cmd === 'c');
        current.push([state.cx, state.cy, c1x, c1y, c2x, c2y, x, y]);
        state.cx = x;
        state.cy = y;
        state.lastCubicC2 = [c2x, c2y];
        state.lastQuadC1 = null;
        break;
      }
      case 'S':
      case 's': {
        if (!current) throw new SyntaxError('S before M');
        // First control point is the reflection of the previous segment's
        // second control point. If there was no preceding C/c/S/s, the
        // first control point coincides with the current point.
        const [c1x, c1y] = state.lastCubicC2
          ? [2 * state.cx - state.lastCubicC2[0], 2 * state.cy - state.lastCubicC2[1]]
          : [state.cx, state.cy];
        const [c2x, c2y] = readPoint(state, cmd === 's');
        const [x,   y  ] = readPoint(state, cmd === 's');
        current.push([state.cx, state.cy, c1x, c1y, c2x, c2y, x, y]);
        state.cx = x;
        state.cy = y;
        state.lastCubicC2 = [c2x, c2y];
        state.lastQuadC1 = null;
        break;
      }
      case 'Q':
      case 'q': {
        if (!current) throw new SyntaxError('Q before M');
        const [qx, qy] = readPoint(state, cmd === 'q');
        const [x, y]  = readPoint(state, cmd === 'q');
        current.push(quadAsCubic(state.cx, state.cy, qx, qy, x, y));
        state.cx = x;
        state.cy = y;
        state.lastQuadC1 = [qx, qy];
        state.lastCubicC2 = null;
        break;
      }
      case 'T':
      case 't': {
        if (!current) throw new SyntaxError('T before M');
        const [qx, qy] = state.lastQuadC1
          ? [2 * state.cx - state.lastQuadC1[0], 2 * state.cy - state.lastQuadC1[1]]
          : [state.cx, state.cy];
        const [x, y] = readPoint(state, cmd === 't');
        current.push(quadAsCubic(state.cx, state.cy, qx, qy, x, y));
        state.cx = x;
        state.cy = y;
        state.lastQuadC1 = [qx, qy];
        state.lastCubicC2 = null;
        break;
      }
      case 'A':
      case 'a': {
        if (!current) throw new SyntaxError('A before M');
        const rx = parseFloat(consume(state));
        const ry = parseFloat(consume(state));
        const rot = parseFloat(consume(state));
        const largeArc = readArcFlag(state);
        const sweep = readArcFlag(state);
        const [x, y] = readPoint(state, cmd === 'a');
        for (const seg of arcAsCubics(
          state.cx, state.cy, rx, ry, rot, largeArc, sweep, x, y,
        )) {
          current.push(seg);
        }
        state.cx = x;
        state.cy = y;
        state.lastCubicC2 = null;
        state.lastQuadC1 = null;
        break;
      }
      case 'Z':
      case 'z': {
        if (!current) throw new SyntaxError('Z before M');
        // Insert a closing line if the last endpoint isn't already at startX/startY
        if (
          Math.abs(state.cx - state.startX) > 1e-6 ||
          Math.abs(state.cy - state.startY) > 1e-6
        ) {
          current.push(lineAsCubic(state.cx, state.cy, state.startX, state.startY));
        }
        state.cx = state.startX;
        state.cy = state.startY;
        state.lastCubicC2 = null;
        state.lastQuadC1 = null;
        cmd = null;
        break;
      }
      default:
        throw new SyntaxError(`unsupported path command "${cmd}"`);
    }
  }

  return { paths: paths.filter((p) => p.length > 0).map((segs) => makePath(segs)) };
}

/* -------------------------------------------------------------------------- */

interface ParserState {
  tokens: string[];
  index: number;
  cx: number;
  cy: number;
  startX: number;
  startY: number;
  lastCubicC2: [number, number] | null;
  lastQuadC1: [number, number] | null;
}

function tokenize(d: string): string[] {
  // SVG path tokens: single-letter commands, or numbers (optionally signed,
  // optionally decimal, optionally with scientific exponent). Commas and
  // whitespace are separators. Numbers can share a sign without a separator
  // (e.g. "1.2-3.4" is two numbers), which this regex handles.
  const re = /[MmLlHhVvCcSsQqTtZzAa]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
  return d.match(re) ?? [];
}

function isCommand(tok: string): boolean {
  return /^[MmLlHhVvCcSsQqTtZzAa]$/.test(tok);
}

function consume(state: ParserState): string {
  const v = state.tokens[state.index];
  if (v === undefined) throw new SyntaxError('unexpected end of path');
  state.index += 1;
  return v;
}

function readPoint(state: ParserState, relative: boolean): [number, number] {
  const x = parseFloat(consume(state));
  const y = parseFloat(consume(state));
  return relative ? [state.cx + x, state.cy + y] : [x, y];
}

function lineAsCubic(x0: number, y0: number, x: number, y: number): CubicSegment {
  // A degenerate cubic along a straight line — controls at 1/3 and 2/3.
  // The renderer treats these like any other cubic; the Newton refinement
  // converges trivially since the derivative is constant.
  const c1x = x0 + (x - x0) / 3;
  const c1y = y0 + (y - y0) / 3;
  const c2x = x0 + (2 * (x - x0)) / 3;
  const c2y = y0 + (2 * (y - y0)) / 3;
  return [x0, y0, c1x, c1y, c2x, c2y, x, y];
}

function quadAsCubic(
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

function readArcFlag(state: ParserState): 0 | 1 {
  // Arc flags are spec'd as a single character "0" or "1", but the number
  // tokenizer happily glues them onto adjacent digits ("0010" reads as one
  // token). Peel off the first character and push the remainder back so it
  // can be consumed as a separate parameter.
  const tok = consume(state);
  const c = tok[0];
  if (c !== '0' && c !== '1') {
    throw new SyntaxError(`arc flag must be 0 or 1, got "${tok}"`);
  }
  if (tok.length > 1) {
    state.tokens.splice(state.index, 0, tok.slice(1));
  }
  return c === '1' ? 1 : 0;
}

/**
 * Convert an SVG elliptical arc command into a sequence of cubic Bezier
 * segments. The arc spans from (x0, y0) to (x, y) along an ellipse with
 * radii (rx, ry) rotated by `phiDeg` degrees; the two flags pick which of
 * the four candidate arcs to draw.
 *
 * Implements the endpoint→center conversion from SVG 1.1 Appendix F.6.5,
 * including the F.6.6 out-of-range corrections (zero-length skip, zero-
 * radius line fallback, |rx|/|ry|, radius scaling). Each ≤90° sub-arc is
 * approximated by a single cubic using the (4/3)·tan(α/4) formula, whose
 * radial error stays well under 0.005 for typical icon-scale radii.
 */
function arcAsCubics(
  x0: number, y0: number,
  rx: number, ry: number,
  phiDeg: number,
  largeArc: 0 | 1, sweep: 0 | 1,
  x: number, y: number,
): CubicSegment[] {
  // F.6.2: identical endpoints → omit the arc entirely.
  if (x0 === x && y0 === y) return [];

  // F.6.6 step 1: take absolute radii.
  rx = Math.abs(rx);
  ry = Math.abs(ry);

  // F.6.2: a zero radius collapses the arc to a straight line.
  if (rx === 0 || ry === 0) return [lineAsCubic(x0, y0, x, y)];

  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // F.6.5 step 1: shift to the chord-midpoint frame, then unrotate by phi.
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p =  cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // F.6.6 step 3: scale up the radii if they're too small to span the chord.
  let rxSq = rx * rx;
  let rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;
  const lambda = x1pSq / rxSq + y1pSq / rySq;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
    rxSq = rx * rx;
    rySq = ry * ry;
  }

  // F.6.5 step 2: solve for the center in the unrotated frame.
  const sign = largeArc === sweep ? -1 : 1;
  const num = rxSq * rySq - rxSq * y1pSq - rySq * x1pSq;
  const den = rxSq * y1pSq + rySq * x1pSq;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp =  coef * (rx * y1p) / ry;
  const cyp = -coef * (ry * x1p) / rx;

  // F.6.5 step 3: rotate the center back and shift to the chord midpoint.
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  // F.6.5 step 4: start angle θ1 and signed sweep Δθ.
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = vectorAngle(1, 0, ux, uy);
  let deltaTheta = vectorAngle(ux, uy, vx, vy);
  if (!sweep && deltaTheta > 0) deltaTheta -= 2 * Math.PI;
  else if (sweep && deltaTheta < 0) deltaTheta += 2 * Math.PI;

  // Subdivide so each cubic spans at most 90°. The (4/3)·tan(α/4)
  // approximation is exact at endpoints and tangent-matched there; max
  // radial error is ≈ 0.00027·max(rx, ry) at α = π/2, falling rapidly for
  // smaller α.
  const n = Math.max(1, Math.ceil(Math.abs(deltaTheta) / (Math.PI / 2)));
  const step = deltaTheta / n;
  const out: CubicSegment[] = [];
  for (let i = 0; i < n; i++) {
    out.push(arcSubAsCubic(cx, cy, rx, ry, cosPhi, sinPhi, theta1 + i * step, theta1 + (i + 1) * step));
  }
  return out;
}

function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  const a = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / len)));
  return ux * vy - uy * vx < 0 ? -a : a;
}

function arcSubAsCubic(
  cx: number, cy: number,
  rx: number, ry: number,
  cosPhi: number, sinPhi: number,
  t1: number, t2: number,
): CubicSegment {
  const alpha = (4 / 3) * Math.tan((t2 - t1) / 4);
  const cos1 = Math.cos(t1);
  const sin1 = Math.sin(t1);
  const cos2 = Math.cos(t2);
  const sin2 = Math.sin(t2);

  // Points are first computed on the (rx, ry)-axis-aligned ellipse, then
  // rotated by phi and translated to (cx, cy). Tangent vectors at the
  // endpoints scale by `alpha` to land the control points on the curve.
  const map = (ex: number, ey: number): [number, number] => [
    cosPhi * ex - sinPhi * ey + cx,
    sinPhi * ex + cosPhi * ey + cy,
  ];
  const [p0x, p0y] = map(rx * cos1, ry * sin1);
  const [p3x, p3y] = map(rx * cos2, ry * sin2);
  const [c1x, c1y] = map(rx * (cos1 - alpha * sin1), ry * (sin1 + alpha * cos1));
  const [c2x, c2y] = map(rx * (cos2 + alpha * sin2), ry * (sin2 - alpha * cos2));
  return [p0x, p0y, c1x, c1y, c2x, c2y, p3x, p3y];
}
