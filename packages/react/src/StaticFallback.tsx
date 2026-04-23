import type { CSSProperties } from 'react';
import type { Mark, Path, RgbColor } from '@bezier-sdf/core';

export interface StaticFallbackProps {
  mark: Mark;
  /** Optional global color override. When omitted, per-path SVG colors are used. */
  color?: string;
  opacity: number;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}

/**
 * Pure-SVG render of a normalized Mark. Used when both WebGPU and WebGL
 * fail to initialize, so the component never shows an empty box on
 * unsupported hardware.
 *
 * The mark is already in normalized `[-1, 1]` shader space (y-up). We
 * negate Y per-point so the SVG viewBox (y-down) produces the same visual
 * orientation as the GPU render.
 */
export function StaticFallback({
  mark,
  color,
  opacity,
  className,
  style,
  ariaLabel,
}: StaticFallbackProps) {
  return (
    <svg
      className={className}
      style={{ width: '100%', height: '100%', display: 'block', ...style }}
      viewBox="-1 -1 2 2"
      preserveAspectRatio="xMidYMid meet"
      role={ariaLabel ? 'img' : 'presentation'}
      aria-label={ariaLabel}
    >
      {mark.paths.map((p, i) => renderPath(p, i, color, opacity))}
    </svg>
  );
}

function renderPath(path: Path, key: number, globalColor: string | undefined, opacity: number) {
  const d = pathToSvgD(path);
  if (!d) return null;

  // When the caller supplied a global color override, every path inherits
  // it — matches the GPU legacy mode.
  if (globalColor !== undefined) {
    return (
      <path
        key={key}
        d={d}
        fill={path.mode === 'stroke' ? 'none' : globalColor}
        stroke={path.mode !== 'fill' ? globalColor : 'none'}
        strokeWidth={path.mode !== 'fill' ? path.strokeWidth : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
        fillRule="evenodd"
        opacity={opacity}
      />
    );
  }

  // Per-path SVG paint.
  const wantFill   = path.mode !== 'stroke';
  const wantStroke = path.mode !== 'fill';
  return (
    <path
      key={key}
      d={d}
      fill={wantFill ? rgbToHex(path.fillColor) : 'none'}
      fillOpacity={wantFill ? path.fillOpacity * opacity : undefined}
      stroke={wantStroke ? rgbToHex(path.strokeColor) : 'none'}
      strokeOpacity={wantStroke ? path.strokeOpacity * opacity : undefined}
      strokeWidth={wantStroke ? path.strokeWidth : undefined}
      strokeLinecap="round"
      strokeLinejoin="round"
      fillRule="evenodd"
    />
  );
}

function pathToSvgD(path: Path): string {
  const segs = path.segments;
  if (segs.length === 0) return '';
  const first = segs[0]!;
  const parts: string[] = [`M ${fmt(first[0]!)} ${fmt(-first[1]!)}`];
  for (const seg of segs) {
    parts.push(
      `C ${fmt(seg[2]!)} ${fmt(-seg[3]!)} ${fmt(seg[4]!)} ${fmt(-seg[5]!)} ${fmt(seg[6]!)} ${fmt(-seg[7]!)}`,
    );
  }
  // Only close fills — leaving stroked open paths unclosed matches the
  // GPU's stroke mode, which renders `|d| < halfWidth` on the curve set
  // without an implicit closing segment.
  if (path.mode !== 'stroke') parts.push('Z');
  return parts.join(' ');
}

function rgbToHex(c: RgbColor): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : '0';
}
