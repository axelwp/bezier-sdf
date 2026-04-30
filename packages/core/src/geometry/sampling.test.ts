import { describe, it, expect } from 'vitest';
import { sampleBezierPath, evalCubic } from './sampling';
import { makePath } from './types';
import type { CubicSegment } from './types';

const lineCubic = (x0: number, y0: number, x: number, y: number): CubicSegment => [
  x0, y0,
  x0 + (x - x0) / 3, y0 + (y - y0) / 3,
  x0 + (2 * (x - x0)) / 3, y0 + (2 * (y - y0)) / 3,
  x, y,
];

describe('evalCubic', () => {
  const seg: CubicSegment = [0, 0, 1, 0, 2, 0, 3, 0]; // straight horizontal cubic

  it('returns P0 at t=0', () => {
    expect(evalCubic(seg, 0)).toEqual([0, 0]);
  });

  it('returns P3 at t=1', () => {
    expect(evalCubic(seg, 1)).toEqual([3, 0]);
  });

  it('lies on a straight line at t=0.5', () => {
    const [x, y] = evalCubic(seg, 0.5);
    expect(x).toBeCloseTo(1.5, 9);
    expect(y).toBeCloseTo(0, 9);
  });

  it('matches the de Casteljau midpoint of a non-trivial cubic', () => {
    // P0=(0,0) P1=(0,2) P2=(2,2) P3=(2,0). At t=0.5 → (1, 1.5).
    const s: CubicSegment = [0, 0, 0, 2, 2, 2, 2, 0];
    const [x, y] = evalCubic(s, 0.5);
    expect(x).toBeCloseTo(1, 9);
    expect(y).toBeCloseTo(1.5, 9);
  });
});

describe('sampleBezierPath', () => {
  it('throws on count < 2', () => {
    const p = makePath([lineCubic(0, 0, 1, 0)]);
    expect(() => sampleBezierPath(p, 1)).toThrow(RangeError);
    expect(() => sampleBezierPath(p, 0)).toThrow(RangeError);
  });

  it('returns a Float32Array of length count*2', () => {
    const p = makePath([lineCubic(0, 0, 1, 0)]);
    const out = sampleBezierPath(p, 7);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(14);
  });

  it('returns zeros for an empty path', () => {
    const empty = makePath([]);
    const out = sampleBezierPath(empty, 4);
    expect(out.length).toBe(8);
    for (const v of out) expect(v).toBe(0);
  });

  it('first sample is the first segment P0; last is the last segment P3', () => {
    const p = makePath([
      lineCubic(0, 0, 5, 0),
      lineCubic(5, 0, 5, 5),
    ]);
    const out = sampleBezierPath(p, 11);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0, 5);
    expect(out[20]).toBeCloseTo(5, 5);
    expect(out[21]).toBeCloseTo(5, 5);
  });

  it('samples lie along a straight line for a linear path', () => {
    const p = makePath([lineCubic(0, 0, 10, 0)]);
    const out = sampleBezierPath(p, 11);
    for (let i = 0; i < out.length; i += 2) {
      expect(out[i + 1]).toBeCloseTo(0, 5);
    }
    // x should be monotonic non-decreasing across samples.
    for (let i = 2; i < out.length; i += 2) {
      expect(out[i]!).toBeGreaterThanOrEqual(out[i - 2]!);
    }
  });
});
