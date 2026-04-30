import { describe, it, expect } from 'vitest';
import { splitCubic, chordLength, subdividePath, subdivideMark } from './subdivide';
import { evalCubic } from './sampling';
import { makePath } from './types';
import type { CubicSegment, Mark } from './types';

const lineCubic = (x0: number, y0: number, x: number, y: number): CubicSegment => [
  x0, y0,
  x0 + (x - x0) / 3, y0 + (y - y0) / 3,
  x0 + (2 * (x - x0)) / 3, y0 + (2 * (y - y0)) / 3,
  x, y,
];

describe('splitCubic', () => {
  it('preserves the original endpoints', () => {
    const seg: CubicSegment = [0, 0, 0, 2, 2, 2, 2, 0];
    const [a, b] = splitCubic(seg);
    expect(a[0]).toBe(seg[0]); expect(a[1]).toBe(seg[1]);
    expect(b[6]).toBe(seg[6]); expect(b[7]).toBe(seg[7]);
  });

  it('joins the two halves at the midpoint of the original curve', () => {
    const seg: CubicSegment = [0, 0, 0, 2, 2, 2, 2, 0];
    const [a, b] = splitCubic(seg);
    const [mx, my] = evalCubic(seg, 0.5);
    expect(a[6]).toBeCloseTo(mx, 9); expect(a[7]).toBeCloseTo(my, 9);
    expect(b[0]).toBeCloseTo(mx, 9); expect(b[1]).toBeCloseTo(my, 9);
  });

  it('union of halves traces the same curve as the original', () => {
    const seg: CubicSegment = [0, 0, 0, 2, 2, 2, 2, 0];
    const [a, b] = splitCubic(seg);
    // Sample t in [0, 0.5] from `a` and t in [0.5, 1] from `b`; both
    // should match `seg` at the same global parameter.
    for (const tg of [0.1, 0.25, 0.4, 0.6, 0.75, 0.9]) {
      const [ex, ey] = evalCubic(seg, tg);
      const [sx, sy] =
        tg <= 0.5
          ? evalCubic(a, tg / 0.5)
          : evalCubic(b, (tg - 0.5) / 0.5);
      expect(sx).toBeCloseTo(ex, 9);
      expect(sy).toBeCloseTo(ey, 9);
    }
  });
});

describe('chordLength', () => {
  it('returns endpoint-to-endpoint Euclidean distance', () => {
    expect(chordLength(lineCubic(0, 0, 3, 4))).toBeCloseTo(5, 9);
    expect(chordLength(lineCubic(1, 1, 1, 1))).toBe(0);
  });
});

describe('subdividePath', () => {
  it('leaves segments under threshold unchanged', () => {
    const p = makePath([lineCubic(0, 0, 0.1, 0)]);
    const { path, truncated } = subdividePath(p, 0.5, 100);
    expect(path.segments).toHaveLength(1);
    expect(truncated).toBe(false);
  });

  it('splits an over-threshold segment recursively', () => {
    const p = makePath([lineCubic(0, 0, 1, 0)]);
    // chord 1.0 with threshold 0.3 → 1.0 → 0.5 → 0.25, two splits, 4 segs.
    const { path, truncated } = subdividePath(p, 0.3, 100);
    expect(path.segments.length).toBeGreaterThanOrEqual(4);
    for (const s of path.segments) expect(chordLength(s)).toBeLessThanOrEqual(0.3);
    expect(truncated).toBe(false);
  });

  it('respects maxSegments and flags truncation', () => {
    const p = makePath([lineCubic(0, 0, 10, 0)]);
    const { path, truncated } = subdividePath(p, 0.01, 4);
    expect(path.segments.length).toBeLessThanOrEqual(4);
    expect(truncated).toBe(true);
  });

  it('preserves path metadata (mode, color, opacity)', () => {
    const p = makePath([lineCubic(0, 0, 1, 0)], {
      mode: 'stroke',
      strokeWidth: 0.5,
      strokeColor: [1, 0, 0],
    });
    const { path } = subdividePath(p, 0.1, 100);
    expect(path.mode).toBe('stroke');
    expect(path.strokeWidth).toBe(0.5);
    expect(path.strokeColor).toEqual([1, 0, 0]);
  });

  it('does not mutate the input path', () => {
    const segs = [lineCubic(0, 0, 1, 0)];
    const p = makePath(segs);
    subdividePath(p, 0.1, 100);
    expect(p.segments.length).toBe(1);
  });
});

describe('subdivideMark', () => {
  it('lifts subdivision over every path', () => {
    const mark: Mark = {
      paths: [
        makePath([lineCubic(0, 0, 1, 0)]),
        makePath([lineCubic(0, 0, 0.05, 0)]), // already under threshold
      ],
    };
    const { mark: out, truncated } = subdivideMark(mark, 0.3, 100);
    expect(out.paths).toHaveLength(2);
    expect(out.paths[0]!.segments.length).toBeGreaterThan(1);
    expect(out.paths[1]!.segments.length).toBe(1);
    expect(truncated).toBe(false);
  });

  it('reports truncation if any path was capped', () => {
    const mark: Mark = {
      paths: [makePath([lineCubic(0, 0, 100, 0)])],
    };
    const { truncated } = subdivideMark(mark, 0.001, 4);
    expect(truncated).toBe(true);
  });
});
