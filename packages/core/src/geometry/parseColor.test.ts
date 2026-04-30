import { describe, it, expect } from 'vitest';
import { parseColor, parseColorAlpha } from './parseColor';

const closeTo = (a: readonly number[] | null, b: readonly number[]) => {
  expect(a).not.toBeNull();
  for (let i = 0; i < b.length; i++) expect(a![i]).toBeCloseTo(b[i]!, 6);
};

describe('parseColor: hex', () => {
  it('parses 6-digit hex', () => {
    closeTo(parseColor('#ff0080'), [1, 0, 128 / 255]);
  });

  it('parses 3-digit hex by doubling each nibble', () => {
    // #abc → 0xaa, 0xbb, 0xcc
    closeTo(parseColor('#abc'), [0xaa / 255, 0xbb / 255, 0xcc / 255]);
  });

  it('parses 4-digit hex (alpha ignored by parseColor)', () => {
    closeTo(parseColor('#abcf'), [0xaa / 255, 0xbb / 255, 0xcc / 255]);
  });

  it('parses 8-digit hex (alpha ignored by parseColor)', () => {
    closeTo(parseColor('#11223380'), [0x11 / 255, 0x22 / 255, 0x33 / 255]);
  });

  it('is case-insensitive', () => {
    closeTo(parseColor('#FFAABB'), [1, 0xaa / 255, 0xbb / 255]);
  });

  it('returns null for invalid hex lengths', () => {
    expect(parseColor('#ff')).toBeNull();
    expect(parseColor('#fffff')).toBeNull();
    expect(parseColor('#fffffff')).toBeNull();
  });
});

describe('parseColor: rgb/rgba', () => {
  it('parses byte-valued rgb()', () => {
    closeTo(parseColor('rgb(255, 0, 128)'), [1, 0, 128 / 255]);
  });

  it('parses percentage rgb()', () => {
    closeTo(parseColor('rgb(100%, 0%, 50%)'), [1, 0, 0.5]);
  });

  it('parses rgba() and ignores the alpha channel', () => {
    closeTo(parseColor('rgba(255, 0, 0, 0.5)'), [1, 0, 0]);
  });

  it('clamps over-1 channels down to 1', () => {
    closeTo(parseColor('rgb(300, 0, 128)'), [1, 0, 128 / 255]);
  });

  it('returns null when a channel is negative (regex rejects leading -)', () => {
    // The channel regex is [\d.]+%? — no sign — so negative inputs cause
    // the whole rgb() parse to fail rather than getting clamped to 0.
    expect(parseColor('rgb(0, -10, 128)')).toBeNull();
  });

  it('accepts space-separated channels (CSS Color 4 style)', () => {
    closeTo(parseColor('rgb(255 0 128)'), [1, 0, 128 / 255]);
  });
});

describe('parseColor: named colors', () => {
  it('parses common names', () => {
    closeTo(parseColor('red'),   [1, 0, 0]);
    closeTo(parseColor('lime'),  [0, 1, 0]);
    closeTo(parseColor('blue'),  [0, 0, 1]);
    closeTo(parseColor('white'), [1, 1, 1]);
    closeTo(parseColor('black'), [0, 0, 0]);
  });

  it('is case-insensitive and trims whitespace', () => {
    closeTo(parseColor('  REbeccaPurple  '), [0x66 / 255, 0x33 / 255, 0x99 / 255]);
  });

  it('returns null for unknown names', () => {
    expect(parseColor('not-a-color')).toBeNull();
  });
});

describe('parseColor: keywords / empty', () => {
  it('returns null for none / transparent / currentcolor', () => {
    expect(parseColor('none')).toBeNull();
    expect(parseColor('transparent')).toBeNull();
    expect(parseColor('currentColor')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseColor('')).toBeNull();
    expect(parseColor('   ')).toBeNull();
  });
});

describe('parseColorAlpha', () => {
  it('returns 1 for colors without alpha', () => {
    expect(parseColorAlpha('#ff0000')).toBe(1);
    expect(parseColorAlpha('rgb(255,0,0)')).toBe(1);
    expect(parseColorAlpha('red')).toBe(1);
  });

  it('extracts alpha from #rrggbbaa', () => {
    expect(parseColorAlpha('#ff000080')).toBeCloseTo(0x80 / 255, 6);
    expect(parseColorAlpha('#000000ff')).toBe(1);
    expect(parseColorAlpha('#00000000')).toBe(0);
  });

  it('extracts alpha from #rgba (fourth nibble doubled)', () => {
    // The alpha nibble 'f' → 0xff/255 = 1
    expect(parseColorAlpha('#abcf')).toBe(1);
    // 'a' → 0xaa/255
    expect(parseColorAlpha('#abca')).toBeCloseTo(0xaa / 255, 6);
  });

  it('extracts alpha from rgba()', () => {
    expect(parseColorAlpha('rgba(0, 0, 0, 0.5)')).toBe(0.5);
    expect(parseColorAlpha('rgba(255, 255, 255, 1)')).toBe(1);
    expect(parseColorAlpha('rgba(0, 0, 0, 0)')).toBe(0);
  });

  it('clamps over-1 alpha down to 1', () => {
    expect(parseColorAlpha('rgba(0, 0, 0, 2)')).toBe(1);
  });

  it('falls through to 1 when alpha is negative (regex rejects leading -)', () => {
    // Same regex limitation as parseColor: no sign allowed, so negative
    // alpha doesn't match → the function returns the "no alpha info" default.
    expect(parseColorAlpha('rgba(0, 0, 0, -1)')).toBe(1);
  });
});
