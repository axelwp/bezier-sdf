import { describe, it, expect } from 'vitest';
import { normalizeMark } from './normalize';
import { parseSvgPath } from './parseSvgPath';
import { makePath } from './types';
import type { CubicSegment, Mark } from './types';

const lineCubic = (x0: number, y0: number, x: number, y: number): CubicSegment => [
  x0, y0,
  x0 + (x - x0) / 3, y0 + (y - y0) / 3,
  x0 + (2 * (x - x0)) / 3, y0 + (2 * (y - y0)) / 3,
  x, y,
];

// A 10×10 square in SVG-space (y down).
const square: Mark = {
  paths: [
    makePath([
      lineCubic(0, 0, 10, 0),
      lineCubic(10, 0, 10, 10),
      lineCubic(10, 10, 0, 10),
      lineCubic(0, 10, 0, 0),
    ]),
  ],
};

describe('normalizeMark: bbox + centering', () => {
  it('centers a square on the origin', () => {
    const { mark, transform } = normalizeMark(square);
    // Endpoints — concat all P0/P3 pairs across segments.
    const pts: number[] = [];
    for (const p of mark.paths) {
      for (const s of p.segments) { pts.push(s[0]!, s[1]!, s[6]!, s[7]!); }
    }
    // bbox of normalized points should be symmetric around 0.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]!); maxX = Math.max(maxX, pts[i]!);
      minY = Math.min(minY, pts[i + 1]!); maxY = Math.max(maxY, pts[i + 1]!);
    }
    expect((minX + maxX) / 2).toBeCloseTo(0, 9);
    expect((minY + maxY) / 2).toBeCloseTo(0, 9);
    expect(transform.offsetX).toBeCloseTo(-5, 9);
    expect(transform.offsetY).toBeCloseTo(-5, 9);
  });

  it('scales the longest axis to the requested extent', () => {
    const { mark } = normalizeMark(square, { extent: 0.95 });
    let minX = Infinity, maxX = -Infinity;
    for (const p of mark.paths) {
      for (const s of p.segments) {
        minX = Math.min(minX, s[0]!, s[6]!);
        maxX = Math.max(maxX, s[0]!, s[6]!);
      }
    }
    expect(maxX - minX).toBeCloseTo(2 * 0.95, 9); // -0.95..+0.95
  });

  it('preserves aspect ratio for non-square marks', () => {
    // 20-wide, 10-tall rectangle.
    const rect: Mark = {
      paths: [makePath([
        lineCubic(0, 0, 20, 0),
        lineCubic(20, 0, 20, 10),
        lineCubic(20, 10, 0, 10),
        lineCubic(0, 10, 0, 0),
      ])],
    };
    const { mark } = normalizeMark(rect, { extent: 1 });
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of mark.paths) {
      for (const s of p.segments) {
        minX = Math.min(minX, s[0]!, s[6]!); maxX = Math.max(maxX, s[0]!, s[6]!);
        minY = Math.min(minY, s[1]!, s[7]!); maxY = Math.max(maxY, s[1]!, s[7]!);
      }
    }
    // Longest axis fills [-1, 1]; shorter axis is scaled by the same factor.
    expect(maxX - minX).toBeCloseTo(2, 9);
    expect(maxY - minY).toBeCloseTo(1, 9);
  });
});

describe('normalizeMark: flipY', () => {
  it('flips Y by default', () => {
    const { mark } = normalizeMark(square);
    // Original min y was 0, max y was 10, center 5. After flip, top of
    // SVG (y=0) becomes +0.95, bottom (y=10) becomes -0.95.
    const ys = mark.paths[0]!.segments.flatMap((s) => [s[1]!, s[7]!]);
    expect(Math.max(...ys)).toBeCloseTo(0.95, 9);
    expect(Math.min(...ys)).toBeCloseTo(-0.95, 9);
  });

  it('preserves Y direction when flipY=false', () => {
    const { mark } = normalizeMark(square, { flipY: false });
    const ys = mark.paths[0]!.segments.flatMap((s) => [s[1]!, s[7]!]);
    expect(Math.max(...ys)).toBeCloseTo(0.95, 9);
    expect(Math.min(...ys)).toBeCloseTo(-0.95, 9);
  });
});

describe('normalizeMark: stroke handling', () => {
  it('expands bbox by stroke half-width', () => {
    // 10-wide line (stroke-only path) with strokeWidth=2 should be treated
    // as if the bbox is 12 wide (10 + 2 * half-stroke).
    const stroked: Mark = {
      paths: [makePath([lineCubic(0, 0, 10, 0)], {
        mode: 'stroke',
        strokeWidth: 2,
      })],
    };
    const { transform } = normalizeMark(stroked, { extent: 1 });
    // Half-extent of 12 → scale = 1 / 6.
    expect(transform.scale).toBeCloseTo(1 / 6, 9);
  });

  it('scales strokeWidth alongside geometry', () => {
    const stroked: Mark = {
      paths: [makePath([
        lineCubic(0, 0, 10, 0),
        lineCubic(10, 0, 10, 10),
        lineCubic(10, 10, 0, 10),
        lineCubic(0, 10, 0, 0),
      ], { mode: 'stroke', strokeWidth: 4 })],
    };
    const { mark, transform } = normalizeMark(stroked, { extent: 0.95 });
    expect(mark.paths[0]!.strokeWidth).toBeCloseTo(4 * transform.scale, 9);
  });
});

describe('normalizeMark: edge cases', () => {
  it('returns identity transform for an empty mark', () => {
    const { mark, transform } = normalizeMark({ paths: [] });
    expect(mark.paths).toHaveLength(0);
    expect(transform.scale).toBe(1);
    expect(transform.offsetX).toBe(0);
    expect(transform.offsetY).toBe(0);
  });

  it('preserves renderMode through the transform', () => {
    const m: Mark = { paths: square.paths, renderMode: 'legacy-smin' };
    const { mark } = normalizeMark(m);
    expect(mark.renderMode).toBe('legacy-smin');
  });

  it('handles parsed SVG paths end-to-end', () => {
    // Round-trip a simple parsed path.
    const m = parseSvgPath('M0 0 L100 0 L100 100 L0 100 Z');
    const { mark } = normalizeMark(m);
    expect(mark.paths).toHaveLength(1);
    expect(mark.paths[0]!.segments.length).toBeGreaterThan(0);
  });
});
