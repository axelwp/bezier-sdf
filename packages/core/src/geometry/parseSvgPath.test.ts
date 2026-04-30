import { describe, it, expect } from 'vitest';
import { parseSvgPath } from './parseSvgPath';
import type { CubicSegment } from './types';

// Helpers --------------------------------------------------------------------

const segments = (d: string): readonly CubicSegment[] =>
  parseSvgPath(d).paths[0]!.segments;

// A line from (x0,y0) to (x,y) becomes a cubic with controls at 1/3 and 2/3.
const lineCubic = (x0: number, y0: number, x: number, y: number): CubicSegment => [
  x0, y0,
  x0 + (x - x0) / 3, y0 + (y - y0) / 3,
  x0 + (2 * (x - x0)) / 3, y0 + (2 * (y - y0)) / 3,
  x, y,
];

const closeTo = (a: readonly number[], b: readonly number[], eps = 1e-9) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i]!, 9);
};

// Tests ----------------------------------------------------------------------

describe('parseSvgPath: structure', () => {
  it('returns a Mark with one path per M', () => {
    const m = parseSvgPath('M0 0 L10 0 M20 20 L30 30');
    expect(m.paths).toHaveLength(2);
  });

  it('drops empty subpaths', () => {
    // A trailing M with no following draw command yields an empty path that
    // the parser filters out.
    const m = parseSvgPath('M0 0 L1 1 M5 5');
    expect(m.paths).toHaveLength(1);
  });

  it('throws when the path does not start with a command', () => {
    expect(() => parseSvgPath('1 2 3 4')).toThrow(SyntaxError);
  });

  it('throws on a draw command before M', () => {
    expect(() => parseSvgPath('L10 10')).toThrow(SyntaxError);
  });

  it('throws on unexpected end of path', () => {
    expect(() => parseSvgPath('M0 0 L10')).toThrow(SyntaxError);
  });
});

describe('parseSvgPath: tokenizer', () => {
  it('treats commas and whitespace as separators', () => {
    const a = segments('M0,0 L10,10');
    const b = segments('M 0 0 L 10 10');
    expect(a).toEqual(b);
  });

  it('splits adjacent signed numbers without a separator', () => {
    // "1.2-3.4" is two tokens: 1.2 and -3.4.
    const segs = segments('M0 0L1.2-3.4');
    expect(segs).toHaveLength(1);
    closeTo(segs[0]!, lineCubic(0, 0, 1.2, -3.4));
  });

  it('parses scientific notation', () => {
    const segs = segments('M0 0 L1e2 2e-1');
    closeTo(segs[0]!, lineCubic(0, 0, 100, 0.2));
  });
});

describe('parseSvgPath: M/m and implicit lineto', () => {
  it('M followed by extra coords becomes implicit L', () => {
    const segs = segments('M0 0 10 0 10 10');
    expect(segs).toHaveLength(2);
    closeTo(segs[0]!, lineCubic(0, 0, 10, 0));
    closeTo(segs[1]!, lineCubic(10, 0, 10, 10));
  });

  it('m at the start is treated as absolute (first M behavior)', () => {
    // Per SVG spec, the first moveto is absolute even if lowercase.
    // This parser does NOT special-case that — it treats `m x y` as relative
    // to the initial (0,0) cursor, which yields the same coordinates anyway.
    const segs = segments('m5 5 l10 0');
    closeTo(segs[0]!, lineCubic(5, 5, 15, 5));
  });

  it('m followed by extra coords becomes implicit l (relative)', () => {
    const segs = segments('M0 0 m5 5 10 0');
    closeTo(segs[0]!, lineCubic(5, 5, 15, 5));
  });
});

describe('parseSvgPath: L/l, H/h, V/v', () => {
  it('absolute lineto', () => {
    const segs = segments('M0 0 L10 20');
    closeTo(segs[0]!, lineCubic(0, 0, 10, 20));
  });

  it('relative lineto accumulates', () => {
    const segs = segments('M10 10 l5 0 l0 5');
    closeTo(segs[0]!, lineCubic(10, 10, 15, 10));
    closeTo(segs[1]!, lineCubic(15, 10, 15, 15));
  });

  it('H draws a horizontal line at the current y', () => {
    const segs = segments('M5 7 H20');
    closeTo(segs[0]!, lineCubic(5, 7, 20, 7));
  });

  it('h is relative', () => {
    const segs = segments('M5 7 h10');
    closeTo(segs[0]!, lineCubic(5, 7, 15, 7));
  });

  it('V/v draws vertical lines', () => {
    const segs = segments('M5 7 V20 v5');
    closeTo(segs[0]!, lineCubic(5, 7, 5, 20));
    closeTo(segs[1]!, lineCubic(5, 20, 5, 25));
  });
});

describe('parseSvgPath: C/c (cubic)', () => {
  it('absolute cubic preserves all four points', () => {
    const segs = segments('M0 0 C1 2 3 4 5 6');
    expect(segs).toHaveLength(1);
    expect([...segs[0]!]).toEqual([0, 0, 1, 2, 3, 4, 5, 6]);
  });

  it('relative cubic offsets from the current point', () => {
    const segs = segments('M10 10 c1 2 3 4 5 6');
    expect([...segs[0]!]).toEqual([10, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('chains repeated cubics under the same command', () => {
    const segs = segments('M0 0 C1 1 2 2 3 3 4 4 5 5 6 6');
    expect(segs).toHaveLength(2);
    expect([...segs[1]!]).toEqual([3, 3, 4, 4, 5, 5, 6, 6]);
  });
});

describe('parseSvgPath: S/s (smooth cubic)', () => {
  it('reflects the previous cubic control point', () => {
    // After C with c2 = (3,4) ending at (5,6), the next S's c1 should be
    // 2*(5,6) - (3,4) = (7,8).
    const segs = segments('M0 0 C1 2 3 4 5 6 S 9 10 11 12');
    expect([...segs[1]!]).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('without a preceding cubic, c1 coincides with the current point', () => {
    const segs = segments('M5 5 S 10 10 15 15');
    expect([...segs[0]!]).toEqual([5, 5, 5, 5, 10, 10, 15, 15]);
  });
});

describe('parseSvgPath: Q/q and T/t (quadratic, elevated)', () => {
  it('elevates a quadratic to the equivalent cubic', () => {
    // P0=(0,0), Q=(3,3), P1=(6,0)
    // C1 = P0 + 2/3*(Q-P0) = (2,2)
    // C2 = P1 + 2/3*(Q-P1) = (4,2)
    const segs = segments('M0 0 Q3 3 6 0');
    closeTo(segs[0]!, [0, 0, 2, 2, 4, 2, 6, 0]);
  });

  it('T reflects the previous quadratic control', () => {
    // After Q with q=(3,3) ending at (6,0), the next T uses
    // q' = 2*(6,0) - (3,3) = (9,-3), endpoint (12,0).
    const segs = segments('M0 0 Q3 3 6 0 T12 0');
    // C1 = (6,0) + 2/3*((9,-3)-(6,0)) = (8,-2)
    // C2 = (12,0) + 2/3*((9,-3)-(12,0)) = (10,-2)
    closeTo(segs[1]!, [6, 0, 8, -2, 10, -2, 12, 0]);
  });
});

describe('parseSvgPath: Z (closepath)', () => {
  it('inserts a closing line when current point != start', () => {
    const segs = segments('M0 0 L10 0 L10 10 Z');
    expect(segs).toHaveLength(3);
    closeTo(segs[2]!, lineCubic(10, 10, 0, 0));
  });

  it('does not double-add a closing line when already at start', () => {
    const segs = segments('M0 0 L10 0 L10 10 L0 0 Z');
    // Three real edges, no synthetic close — the L0 0 already closed it.
    expect(segs).toHaveLength(3);
  });

  it('resets the current point so subsequent M is independent', () => {
    const m = parseSvgPath('M0 0 L10 10 Z M20 20 l5 0');
    expect(m.paths).toHaveLength(2);
    closeTo(m.paths[1]!.segments[0]!, lineCubic(20, 20, 25, 20));
  });
});

describe('parseSvgPath: A/a (elliptical arc)', () => {
  // Sample a cubic at parameter t.
  const cubicAt = (s: CubicSegment, t: number): [number, number] => {
    const u = 1 - t;
    const b0 = u * u * u;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b3 = t * t * t;
    return [
      b0 * s[0] + b1 * s[2] + b2 * s[4] + b3 * s[6],
      b0 * s[1] + b1 * s[3] + b2 * s[5] + b3 * s[7],
    ];
  };

  it('subdivides at 90° boundaries', () => {
    // Half-circle (180°) → 2 cubics; 270° → 3; 360° (via two semicircles
    // with same start/end) is impossible per F.6.2, so test 270° via large-arc.
    const half = segments('M-1 0 A1 1 0 0 1 1 0');
    expect(half).toHaveLength(2);

    // 270° sweep from (1,0) to (0,1) on the origin-centered unit circle.
    // Of the four flag combinations between these endpoints, (large=1, sweep=0)
    // is the long arc around (0,0); (large=1, sweep=1) would walk the unit
    // circle centered at (1,1) instead.
    const threeQuarters = segments('M1 0 A1 1 0 1 0 0 1');
    expect(threeQuarters).toHaveLength(3);

    // A small arc (≤90°) becomes a single cubic.
    const small = segments('M1 0 A1 1 0 0 1 0 1');
    expect(small).toHaveLength(1);
  });

  it('endpoints match the command', () => {
    const segs = segments('M10 0 A10 10 0 0 1 -10 0');
    expect(segs[0]![0]).toBeCloseTo(10);
    expect(segs[0]![1]).toBeCloseTo(0);
    const last = segs[segs.length - 1]!;
    expect(last[6]).toBeCloseTo(-10);
    expect(last[7]).toBeCloseTo(0);
  });

  it('approximates a circular arc within 0.005 of the true radius', () => {
    // Unit circle from (1,0) sweeping 270° back to (0,1) around the origin.
    // At each sampled point along the cubics, the distance to the origin
    // should be very close to 1 (the radius).
    const segs = segments('M1 0 A1 1 0 1 0 0 1');
    let maxErr = 0;
    for (const s of segs) {
      for (let i = 0; i <= 20; i++) {
        const [x, y] = cubicAt(s, i / 20);
        maxErr = Math.max(maxErr, Math.abs(Math.hypot(x, y) - 1));
      }
    }
    expect(maxErr).toBeLessThan(0.005);
  });

  it('approximates an elliptical, rotated arc within 0.005', () => {
    // Ellipse with rx=2, ry=1, rotated 30°, full sweep around.
    // Verify each sampled point lies on the rotated ellipse:
    //   ((x'·cosφ + y'·sinφ) / rx)² + ((-x'·sinφ + y'·cosφ) / ry)² = 1
    // where (x', y') is the point relative to the center.
    const rx = 2, ry = 1, phi = (30 * Math.PI) / 180, cx = 5, cy = 7;
    const segs = segments(`M${cx + rx * Math.cos(phi)} ${cy + rx * Math.sin(phi)} A${rx} ${ry} 30 1 1 ${cx - rx * Math.cos(phi)} ${cy - rx * Math.sin(phi)}`);
    const c = Math.cos(phi), s = Math.sin(phi);
    let maxErr = 0;
    for (const seg of segs) {
      for (let i = 0; i <= 20; i++) {
        const [x, y] = cubicAt(seg, i / 20);
        const dx = x - cx, dy = y - cy;
        const u = (c * dx + s * dy) / rx;
        const v = (-s * dx + c * dy) / ry;
        // Distance from the ellipse along the radial direction is ≈ |√(u²+v²) − 1| · min(rx, ry).
        const radial = Math.abs(Math.hypot(u, v) - 1) * Math.min(rx, ry);
        maxErr = Math.max(maxErr, radial);
      }
    }
    expect(maxErr).toBeLessThan(0.005);
  });

  it('large-arc-flag selects the long way around', () => {
    // From (1,0) to (0,1) on the origin-centered unit circle: the small arc
    // (large=0, sweep=1) hugs the +x/+y quadrant; the long arc (large=1,
    // sweep=0) wraps the other way through the −x/−y quadrants.
    const small = segments('M1 0 A1 1 0 0 1 0 1');
    const large = segments('M1 0 A1 1 0 1 0 0 1');
    // Midpoint of the path's middle cubic gives a representative interior point.
    const [smX] = cubicAt(small[0]!, 0.5);
    const [lgX] = cubicAt(large[Math.floor(large.length / 2)]!, 0.5);
    expect(smX).toBeGreaterThan(0);
    expect(lgX).toBeLessThan(0);
  });

  it('sweep-flag flips the arc direction', () => {
    // sweep=0 (counterclockwise in SVG's y-down sense, i.e. negative angle
    // direction) vs sweep=1 from (1,0) to (-1,0), small arc — they pick
    // opposite halves of the unit circle (y < 0 vs y > 0).
    const a = segments('M1 0 A1 1 0 0 0 -1 0');
    const b = segments('M1 0 A1 1 0 0 1 -1 0');
    const [, ay] = cubicAt(a[0]!, 0.5);
    const [, by] = cubicAt(b[0]!, 0.5);
    expect(Math.sign(ay)).not.toBe(Math.sign(by));
  });

  it('lowercase a is relative', () => {
    const segs = segments('M10 10 a5 5 0 0 1 5 5');
    // Endpoint should land at (15, 15).
    const last = segs[segs.length - 1]!;
    expect(last[6]).toBeCloseTo(15);
    expect(last[7]).toBeCloseTo(15);
  });

  it('skips zero-length arcs (start == end)', () => {
    const segs = segments('M0 0 A5 5 0 0 1 0 0 L10 10');
    // Only the L10 10 should produce a segment.
    expect(segs).toHaveLength(1);
    closeTo(segs[0]!, lineCubic(0, 0, 10, 10));
  });

  it('falls back to a straight line when rx or ry is zero', () => {
    const a = segments('M0 0 A0 5 0 0 1 10 10');
    const b = segments('M0 0 A5 0 0 0 1 10 10');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    closeTo(a[0]!, lineCubic(0, 0, 10, 10));
    closeTo(b[0]!, lineCubic(0, 0, 10, 10));
  });

  it('takes |rx| and |ry| of negative radii', () => {
    // Negative radii must produce identical geometry to their absolute values.
    const neg = segments('M1 0 A-1 -1 0 0 1 -1 0');
    const pos = segments('M1 0 A1 1 0 0 1 -1 0');
    expect(neg).toHaveLength(pos.length);
    for (let i = 0; i < pos.length; i++) {
      closeTo(neg[i]!, [...pos[i]!], 1e-9);
    }
  });

  it('scales radii up when too small to span the chord', () => {
    // Chord length √2 with rx=ry=0.5 is impossible — radii must scale to
    // ≥ √2/2. Result should still land at the requested endpoint and trace
    // a smooth curve through the midpoint.
    const segs = segments('M0 0 A0.5 0.5 0 0 1 1 1');
    const last = segs[segs.length - 1]!;
    expect(last[6]).toBeCloseTo(1);
    expect(last[7]).toBeCloseTo(1);
  });

  it('handles arc flags packed without separators', () => {
    // svgo-style compact emit: "A1 1 0 0010 0" packs both flags + endpoint.
    const a = segments('M0 to-replace'.replace('to-replace', '0 A1 1 0 0010 0'));
    expect(a.length).toBeGreaterThan(0);
    const last = a[a.length - 1]!;
    expect(last[6]).toBeCloseTo(10);
    expect(last[7]).toBeCloseTo(0);
  });

  it('chains arc parameter sets under one command', () => {
    // After "A …", repeated 7-tuples continue as more arcs (per SVG grammar).
    const segs = segments('M0 0 A1 1 0 0 1 2 0 1 1 0 0 1 4 0');
    // Two 180° arcs: at least 2 cubics each → at least 4 total.
    expect(segs.length).toBeGreaterThanOrEqual(4);
    const last = segs[segs.length - 1]!;
    expect(last[6]).toBeCloseTo(4);
    expect(last[7]).toBeCloseTo(0);
  });

  it('throws on a malformed arc flag', () => {
    expect(() => parseSvgPath('M0 0 A1 1 0 2 0 10 0')).toThrow(SyntaxError);
  });
});

describe('parseSvgPath: defaults', () => {
  it('produces fill-mode paths with sensible defaults', () => {
    const p = parseSvgPath('M0 0 L1 1 Z').paths[0]!;
    expect(p.mode).toBe('fill');
    expect(p.strokeWidth).toBe(0);
    expect(p.fillColor).toEqual([0, 0, 0]);
    expect(p.fillOpacity).toBe(1);
  });
});
