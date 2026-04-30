import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prepareMorphPair, MORPH_MAX_PATHS } from './morphPair';
import { makePath } from './types';
import type { CubicSegment, Mark } from './types';

const seg = (i: number): CubicSegment => [i, 0, i, 0, i, 0, i, 0];

const markWithN = (n: number, mode: 'fill' | 'stroke' = 'fill'): Mark => ({
  paths: Array.from({ length: n }, (_, i) =>
    makePath([seg(i)], { mode, strokeWidth: 0.1 + i * 0.01 }),
  ),
});

describe('prepareMorphPair: under cap', () => {
  it('passes both marks through unchanged', () => {
    const a = markWithN(3);
    const b = markWithN(MORPH_MAX_PATHS);
    const { markA, markB } = prepareMorphPair(a, b);
    expect(markA).toBe(a);
    expect(markB).toBe(b);
  });
});

describe('prepareMorphPair: over cap', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('caps to MORPH_MAX_PATHS paths total', () => {
    const m = markWithN(MORPH_MAX_PATHS + 5);
    const { markA } = prepareMorphPair(m, markWithN(1));
    expect(markA.paths).toHaveLength(MORPH_MAX_PATHS);
  });

  it('preserves the head paths verbatim', () => {
    const m = markWithN(MORPH_MAX_PATHS + 5);
    const { markA } = prepareMorphPair(m, markWithN(1));
    for (let i = 0; i < MORPH_MAX_PATHS - 1; i++) {
      expect(markA.paths[i]).toBe(m.paths[i]);
    }
  });

  it('merges trailing path segments into the last allowed slot', () => {
    const m = markWithN(MORPH_MAX_PATHS + 3);
    const { markA } = prepareMorphPair(m, markWithN(1));
    // Tail = paths [MORPH_MAX_PATHS-1 .. end] = 4 paths × 1 segment each.
    expect(markA.paths[MORPH_MAX_PATHS - 1]!.segments).toHaveLength(4);
  });

  it('inherits paint metadata from the anchor (first tail) path', () => {
    const m = markWithN(MORPH_MAX_PATHS + 2, 'stroke');
    const anchor = m.paths[MORPH_MAX_PATHS - 1]!;
    const { markA } = prepareMorphPair(m, markWithN(1));
    const merged = markA.paths[MORPH_MAX_PATHS - 1]!;
    expect(merged.mode).toBe(anchor.mode);
    expect(merged.strokeWidth).toBe(anchor.strokeWidth);
  });

  it('warns once per side per call', () => {
    prepareMorphPair(markWithN(MORPH_MAX_PATHS + 1), markWithN(MORPH_MAX_PATHS + 1));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('preserves renderMode through the merge', () => {
    const m: Mark = { ...markWithN(MORPH_MAX_PATHS + 1), renderMode: 'legacy-smin' };
    const { markA } = prepareMorphPair(m, markWithN(1));
    expect(markA.renderMode).toBe('legacy-smin');
  });

  it('is deterministic: same input → equal output', () => {
    const m = markWithN(MORPH_MAX_PATHS + 4);
    const a = prepareMorphPair(m, markWithN(1));
    const b = prepareMorphPair(m, markWithN(1));
    expect(a.markA.paths).toEqual(b.markA.paths);
  });
});
