import { describe, it, expect, vi } from 'vitest';
import {
  IDENTITY_FIELD,
  composeFields,
  distortPath,
  distortMark,
  cursorField,
  type DistortionField,
} from './distort';
import { makePath } from './types';
import type { CubicSegment, Mark } from './types';

const seg: CubicSegment = [0, 0, 1, 1, 2, 2, 3, 3];

describe('IDENTITY_FIELD', () => {
  it('returns zero displacement everywhere', () => {
    expect(IDENTITY_FIELD.displace(0, 0)).toEqual([0, 0]);
    expect(IDENTITY_FIELD.displace(100, -50)).toEqual([0, 0]);
  });
});

describe('composeFields', () => {
  const constant = (dx: number, dy: number): DistortionField => ({
    displace: () => [dx, dy],
  });

  it('returns IDENTITY_FIELD when given no fields', () => {
    expect(composeFields()).toBe(IDENTITY_FIELD);
  });

  it('returns the single field unchanged when given one', () => {
    const f = constant(1, 2);
    expect(composeFields(f)).toBe(f);
  });

  it('sums displacements vector-wise', () => {
    const f = composeFields(constant(1, 2), constant(3, -1), constant(0, 5));
    expect(f.displace(0, 0)).toEqual([4, 6]);
  });
});

describe('distortPath', () => {
  it('applies the field to every control point of every segment', () => {
    const f = { displace: () => [1, -1] as const };
    const p = makePath([seg]);
    const out = distortPath(p, f);
    expect([...out.segments[0]!]).toEqual([
      0 + 1, 0 - 1,
      1 + 1, 1 - 1,
      2 + 1, 2 - 1,
      3 + 1, 3 - 1,
    ]);
  });

  it('does not mutate the input', () => {
    const p = makePath([seg]);
    distortPath(p, { displace: () => [1, 1] });
    expect([...p.segments[0]!]).toEqual([...seg]);
  });

  it('preserves paint metadata', () => {
    const p = makePath([seg], { mode: 'stroke', strokeWidth: 0.3, strokeColor: [1, 0, 0] });
    const out = distortPath(p, { displace: () => [0.1, 0.1] });
    expect(out.mode).toBe('stroke');
    expect(out.strokeWidth).toBe(0.3);
    expect(out.strokeColor).toEqual([1, 0, 0]);
  });

  it('passes the segment coordinates to the field', () => {
    const spy = vi.fn().mockReturnValue([0, 0] as const);
    distortPath(makePath([seg]), { displace: spy });
    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy).toHaveBeenCalledWith(0, 0);
    expect(spy).toHaveBeenCalledWith(1, 1);
    expect(spy).toHaveBeenCalledWith(2, 2);
    expect(spy).toHaveBeenCalledWith(3, 3);
  });
});

describe('distortMark', () => {
  it('lifts distortion over every path in the mark', () => {
    const m: Mark = { paths: [makePath([seg]), makePath([seg])] };
    const out = distortMark(m, { displace: () => [1, 0] });
    expect(out.paths).toHaveLength(2);
    for (const p of out.paths) {
      expect(p.segments[0]![0]).toBe(1);
    }
  });
});

describe('cursorField', () => {
  it('returns IDENTITY_FIELD when pull is 0', () => {
    expect(cursorField({ cursor: [0, 0], pull: 0, radius: 1 })).toBe(IDENTITY_FIELD);
  });

  it('decays to ~zero far outside the radius', () => {
    const f = cursorField({ cursor: [0, 0], pull: 1, radius: 0.1 });
    const [dx, dy] = f.displace(5, 5); // ~50 radii away
    expect(Math.hypot(dx, dy)).toBeLessThan(1e-6);
  });

  it('produces ~zero displacement at the cursor itself (1e-6 guard)', () => {
    const f = cursorField({ cursor: [0, 0], pull: 1, radius: 1 });
    const [dx, dy] = f.displace(0, 0);
    expect(Math.hypot(dx, dy)).toBeLessThan(1e-3);
  });

  it('points toward the cursor', () => {
    // Cursor at +x; a point to the left should pull right (positive dx).
    const f = cursorField({ cursor: [1, 0], pull: 0.5, radius: 1 });
    const [dx, dy] = f.displace(0, 0);
    expect(dx).toBeGreaterThan(0);
    expect(dy).toBeCloseTo(0, 9);
  });

  it('is symmetric: opposite-side points pull in opposite directions', () => {
    const f = cursorField({ cursor: [0, 0], pull: 1, radius: 1 });
    const [dxA] = f.displace(0.5, 0);
    const [dxB] = f.displace(-0.5, 0);
    expect(dxA).toBeLessThan(0);
    expect(dxB).toBeGreaterThan(0);
    expect(dxA).toBeCloseTo(-dxB, 9);
  });

  it('is deterministic: same input → same output', () => {
    const f = cursorField({ cursor: [0.3, -0.2], pull: 0.4, radius: 0.5 });
    expect(f.displace(0.1, 0.1)).toEqual(f.displace(0.1, 0.1));
  });
});
