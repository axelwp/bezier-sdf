import { describe, it, expect } from 'vitest';
import { makeTransform } from './helpers';

// Note: only `makeTransform` is covered here — it's pure math. The other
// helpers (`buildPath2D`, `buildMark`, `buildMaskPixels`, `perturbPath`)
// touch `Path2D` and `<canvas>` 2D context APIs that jsdom doesn't
// implement; they belong in a future browser-runner tier.

describe('makeTransform', () => {
  it('maps the origin to the canvas center', () => {
    const t = makeTransform(400, 200);
    expect(t(0, 0)).toEqual([200, 100]);
  });

  it('flips Y so logo +y maps to canvas -y (toward top)', () => {
    const t = makeTransform(200, 200);
    const [, yUp] = t(0, 1);
    const [, yDown] = t(0, -1);
    expect(yUp).toBeLessThan(100); // logo +1 → above center
    expect(yDown).toBeGreaterThan(100); // logo -1 → below center
  });

  it('fits the logo box to the shorter dimension at zoom=1', () => {
    // 400×200 canvas, shorter axis is 200 → scale = 100.
    const t = makeTransform(400, 200);
    expect(t(1, 0)).toEqual([200 + 100, 100]);
    expect(t(-1, 0)).toEqual([200 - 100, 100]);
    expect(t(0, 1)).toEqual([200, 100 - 100]);
  });

  it('scales by zoom', () => {
    const t1 = makeTransform(200, 200, 1);
    const t2 = makeTransform(200, 200, 2);
    const [x1] = t1(1, 0);
    const [x2] = t2(1, 0);
    expect(x2 - 100).toBe((x1 - 100) * 2);
  });

  it('is its own inverse around the center for symmetric coordinates', () => {
    const t = makeTransform(300, 300);
    const [ax, ay] = t(0.5, 0.5);
    const [bx, by] = t(-0.5, -0.5);
    expect(ax + bx).toBeCloseTo(2 * 150, 9);
    expect(ay + by).toBeCloseTo(2 * 150, 9);
  });

  it('handles a square canvas correctly', () => {
    const t = makeTransform(100, 100);
    expect(t(1, 0)).toEqual([100, 50]);
    expect(t(0, -1)).toEqual([50, 100]);
  });
});
