// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSvgDocument } from './parseSvgDocument';

const wrap = (inner: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" ${attrs}>${inner}</svg>`;

describe('parseSvgDocument: structure / errors', () => {
  it('throws when no <path> elements exist', () => {
    expect(() => parseSvgDocument(wrap('<rect width="10" height="10"/>'))).toThrow(
      /no <path>/,
    );
  });

  it('throws when paths exist but none has a `d` attribute', () => {
    expect(() => parseSvgDocument(wrap('<path/>'))).toThrow(/no usable `d`/);
  });

  it('throws on a malformed XML document', () => {
    // Unclosed tag → DOMParser produces a <parsererror>.
    expect(() => parseSvgDocument('<svg><path d="')).toThrow(/SVG parse error/);
  });

  it('returns one Path per <path> with a `d`', () => {
    const m = parseSvgDocument(wrap('<path d="M0 0 L1 1"/><path d="M2 2 L3 3"/>'));
    expect(m.paths).toHaveLength(2);
  });

  it('flattens multi-subpath `d` into one Path', () => {
    // Compound shape with two M subpaths → single Path.
    const m = parseSvgDocument(wrap('<path d="M0 0 L10 0 Z M5 5 L8 5 Z"/>'));
    expect(m.paths).toHaveLength(1);
  });
});

describe('parseSvgDocument: paint resolution', () => {
  it('defaults fill to black, no stroke', () => {
    const p = parseSvgDocument(wrap('<path d="M0 0 L1 1"/>')).paths[0]!;
    expect(p.mode).toBe('fill');
    expect(p.fillColor).toEqual([0, 0, 0]);
  });

  it('reads fill from attribute', () => {
    const p = parseSvgDocument(wrap('<path d="M0 0 L1 1" fill="red"/>')).paths[0]!;
    expect(p.fillColor).toEqual([1, 0, 0]);
  });

  it('reads fill from inline style (style takes priority over attribute)', () => {
    const p = parseSvgDocument(
      wrap('<path d="M0 0 L1 1" fill="red" style="fill: blue"/>'),
    ).paths[0]!;
    expect(p.fillColor).toEqual([0, 0, 1]);
  });

  it('renders stroke-only when fill is "none"', () => {
    const p = parseSvgDocument(
      wrap('<path d="M0 0 L1 1" fill="none" stroke="red"/>'),
    ).paths[0]!;
    expect(p.mode).toBe('stroke');
    expect(p.strokeColor).toEqual([1, 0, 0]);
  });

  it('renders both when fill and stroke are set', () => {
    const p = parseSvgDocument(
      wrap('<path d="M0 0 L1 1" fill="red" stroke="blue"/>'),
    ).paths[0]!;
    expect(p.mode).toBe('both');
  });

  it('inherits paint from <g>', () => {
    const p = parseSvgDocument(
      wrap('<g fill="lime"><path d="M0 0 L1 1"/></g>'),
    ).paths[0]!;
    expect(p.fillColor).toEqual([0, 1, 0]);
  });

  it('path attribute beats ancestor attribute', () => {
    const p = parseSvgDocument(
      wrap('<g fill="red"><path d="M0 0 L1 1" fill="blue"/></g>'),
    ).paths[0]!;
    expect(p.fillColor).toEqual([0, 0, 1]);
  });

  it('inherits from the <svg> root', () => {
    const p = parseSvgDocument(wrap('<path d="M0 0 L1 1"/>', 'fill="red"')).paths[0]!;
    expect(p.fillColor).toEqual([1, 0, 0]);
  });

  it('substitutes currentColor with the option', () => {
    const m = parseSvgDocument(
      wrap('<path d="M0 0 L1 1" fill="currentColor"/>'),
      { currentColor: [0.25, 0.5, 0.75] },
    );
    expect(m.paths[0]!.fillColor).toEqual([0.25, 0.5, 0.75]);
  });

  it('parses stroke-width', () => {
    const p = parseSvgDocument(
      wrap('<path d="M0 0 L1 1" stroke="red" stroke-width="2.5"/>'),
    ).paths[0]!;
    expect(p.strokeWidth).toBe(2.5);
  });

  it('defaults stroke-width to 1 when stroked but unspecified', () => {
    const p = parseSvgDocument(
      wrap('<path d="M0 0 L1 1" stroke="red"/>'),
    ).paths[0]!;
    expect(p.strokeWidth).toBe(1);
  });

  it('clamps fill-opacity to 0..1', () => {
    const p = parseSvgDocument(
      wrap('<path d="M0 0 L1 1" fill-opacity="2"/>'),
    ).paths[0]!;
    expect(p.fillOpacity).toBe(1);
  });

  it('multiplies hex alpha into fillOpacity', () => {
    // #80 hex alpha = 128/255 ≈ 0.502
    const p = parseSvgDocument(
      wrap('<path d="M0 0 L1 1" fill="#ff000080"/>'),
    ).paths[0]!;
    expect(p.fillOpacity).toBeCloseTo(128 / 255, 6);
  });

  it('multiplies fill-opacity with hex alpha', () => {
    const p = parseSvgDocument(
      wrap('<path d="M0 0 L1 1" fill="#ff000080" fill-opacity="0.5"/>'),
    ).paths[0]!;
    expect(p.fillOpacity).toBeCloseTo(0.5 * 128 / 255, 6);
  });
});

describe('parseSvgDocument: maxPaths cap', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('caps at maxPaths and warns', () => {
    const inner = Array.from({ length: 20 }, (_, i) => `<path d="M${i} 0 L${i + 1} 1"/>`).join('');
    const m = parseSvgDocument(wrap(inner), { maxPaths: 5 });
    expect(m.paths).toHaveLength(5);
    expect(warn).toHaveBeenCalledOnce();
    expect((warn.mock.calls[0]![0] as string)).toMatch(/exceeds renderer limit/);
  });

  it('does not warn when at-or-under cap', () => {
    const inner = Array.from({ length: 5 }, (_, i) => `<path d="M${i} 0 L${i + 1} 1"/>`).join('');
    parseSvgDocument(wrap(inner), { maxPaths: 16 });
    expect(warn).not.toHaveBeenCalled();
  });
});
