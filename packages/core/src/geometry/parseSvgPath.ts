import type { CubicSegment, Path, Mark } from './types';

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
 *   Z / z — closepath
 *
 * Elliptical arcs (`A` / `a`) are not supported — run your SVG through
 * Inkscape's `Path → Flatten` first, or use a tool like `svgo --pretty
 * --config '{"plugins":[{"name":"convertPathData","params":{"makeArcs":
 * false}}]}'` to approximate arcs with cubics before parsing.
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

  const paths: Path[] = [];
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

  return { paths: paths.filter((p) => p.length > 0) };
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
  const re = /[MmLlHhVvCcSsQqTtZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
  return d.match(re) ?? [];
}

function isCommand(tok: string): boolean {
  return /^[MmLlHhVvCcSsQqTtZz]$/.test(tok);
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
