import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StaticFallback } from './StaticFallback';
import { makePath, type Mark, type CubicSegment } from '@bezier-sdf/core';

const lineCubic = (x0: number, y0: number, x: number, y: number): CubicSegment => [
  x0, y0,
  x0 + (x - x0) / 3, y0 + (y - y0) / 3,
  x0 + (2 * (x - x0)) / 3, y0 + (2 * (y - y0)) / 3,
  x, y,
];

const square: Mark = {
  paths: [makePath([
    lineCubic(-0.5, -0.5, 0.5, -0.5),
    lineCubic(0.5, -0.5, 0.5, 0.5),
    lineCubic(0.5, 0.5, -0.5, 0.5),
    lineCubic(-0.5, 0.5, -0.5, -0.5),
  ])],
};

describe('StaticFallback: container', () => {
  it('renders an <svg> with the [-1,-1,2,2] viewBox', () => {
    const { container } = render(<StaticFallback mark={square} opacity={1} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('viewBox')).toBe('-1 -1 2 2');
  });

  it('uses role=presentation when no ariaLabel is given', () => {
    const { container } = render(<StaticFallback mark={square} opacity={1} />);
    expect(container.querySelector('svg')!.getAttribute('role')).toBe('presentation');
  });

  it('uses role=img and propagates ariaLabel when provided', () => {
    const { container } = render(
      <StaticFallback mark={square} opacity={1} ariaLabel="company logo" />,
    );
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('company logo');
  });

  it('applies className and merges style', () => {
    const { container } = render(
      <StaticFallback mark={square} opacity={1} className="logo" style={{ color: 'red' }} />,
    );
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('class')).toBe('logo');
    // React serializes style; just check the override is present.
    expect(svg.getAttribute('style')).toMatch(/color:\s*red/);
  });
});

describe('StaticFallback: per-path paint', () => {
  it('emits one <path> per path in fill mode by default', () => {
    const { container } = render(<StaticFallback mark={square} opacity={1} />);
    const paths = container.querySelectorAll('path');
    expect(paths).toHaveLength(1);
    expect(paths[0]!.getAttribute('fill')).toBe('#000000');
    expect(paths[0]!.getAttribute('stroke')).toBe('none');
  });

  it('renders stroke-only for mode=stroke', () => {
    const stroked: Mark = {
      paths: [makePath([lineCubic(-0.5, 0, 0.5, 0)], {
        mode: 'stroke',
        strokeWidth: 0.05,
        strokeColor: [1, 0, 0],
      })],
    };
    const { container } = render(<StaticFallback mark={stroked} opacity={1} />);
    const p = container.querySelector('path')!;
    expect(p.getAttribute('fill')).toBe('none');
    expect(p.getAttribute('stroke')).toBe('#ff0000');
    expect(p.getAttribute('stroke-width')).toBe('0.05');
  });

  it('renders both fill and stroke for mode=both', () => {
    const both: Mark = {
      paths: [makePath([lineCubic(-0.5, 0, 0.5, 0), lineCubic(0.5, 0, -0.5, 0)], {
        mode: 'both',
        strokeWidth: 0.02,
        fillColor: [0, 1, 0],
        strokeColor: [0, 0, 1],
      })],
    };
    const { container } = render(<StaticFallback mark={both} opacity={1} />);
    const p = container.querySelector('path')!;
    expect(p.getAttribute('fill')).toBe('#00ff00');
    expect(p.getAttribute('stroke')).toBe('#0000ff');
  });

  it('multiplies fill-opacity by the global opacity prop', () => {
    const m: Mark = {
      paths: [makePath([lineCubic(-0.5, 0, 0.5, 0), lineCubic(0.5, 0, -0.5, 0)], {
        fillOpacity: 0.5,
      })],
    };
    const { container } = render(<StaticFallback mark={m} opacity={0.5} />);
    expect(container.querySelector('path')!.getAttribute('fill-opacity')).toBe('0.25');
  });
});

describe('StaticFallback: global color override', () => {
  const m: Mark = {
    paths: [makePath([lineCubic(-0.5, 0, 0.5, 0), lineCubic(0.5, 0, -0.5, 0)], {
      mode: 'fill',
      fillColor: [1, 0, 0],
    })],
  };

  it('applies the color to fills', () => {
    const { container } = render(<StaticFallback mark={m} color="#abcdef" opacity={1} />);
    const p = container.querySelector('path')!;
    expect(p.getAttribute('fill')).toBe('#abcdef');
    expect(p.getAttribute('stroke')).toBe('none');
  });

  it('applies the color to strokes when mode is stroke', () => {
    const stroked: Mark = {
      paths: [makePath([lineCubic(-0.5, 0, 0.5, 0)], { mode: 'stroke', strokeWidth: 0.1 })],
    };
    const { container } = render(<StaticFallback mark={stroked} color="#ff00ff" opacity={1} />);
    const p = container.querySelector('path')!;
    expect(p.getAttribute('fill')).toBe('none');
    expect(p.getAttribute('stroke')).toBe('#ff00ff');
  });

  it('emits a single opacity attribute (not fill/stroke-opacity) under override', () => {
    const { container } = render(<StaticFallback mark={m} color="#000" opacity={0.4} />);
    const p = container.querySelector('path')!;
    expect(p.getAttribute('opacity')).toBe('0.4');
    expect(p.hasAttribute('fill-opacity')).toBe(false);
  });
});

describe('StaticFallback: path data', () => {
  it('negates Y so logo +y maps to viewBox -y', () => {
    const m: Mark = {
      paths: [makePath([lineCubic(0, 0, 0, 1)])], // straight up in logo space
    };
    const { container } = render(<StaticFallback mark={m} opacity={1} />);
    const d = container.querySelector('path')!.getAttribute('d')!;
    // Path ends at y=1 in logo space → -1 in SVG-space d.
    expect(d).toMatch(/-1\.0000(?:\s|$)/);
  });

  it('closes fill paths with Z', () => {
    const { container } = render(<StaticFallback mark={square} opacity={1} />);
    expect(container.querySelector('path')!.getAttribute('d')).toMatch(/Z$/);
  });

  it('does not close stroke-mode paths', () => {
    const stroked: Mark = {
      paths: [makePath([lineCubic(-0.5, 0, 0.5, 0)], { mode: 'stroke', strokeWidth: 0.05 })],
    };
    const { container } = render(<StaticFallback mark={stroked} opacity={1} />);
    expect(container.querySelector('path')!.getAttribute('d')).not.toMatch(/Z$/);
  });

  it('skips paths with empty segment lists', () => {
    const m: Mark = {
      paths: [makePath([]), makePath([lineCubic(-0.5, 0, 0.5, 0)])],
    };
    const { container } = render(<StaticFallback mark={m} opacity={1} />);
    expect(container.querySelectorAll('path')).toHaveLength(1);
  });
});
