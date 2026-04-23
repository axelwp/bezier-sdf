import type { CSSProperties } from 'react';
import type { Mark } from '@bezier-sdf/core';

export interface StaticFallbackProps {
  mark: Mark;
  color: string;
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
 * orientation as the GPU render. `preserveAspectRatio="xMidYMid meet"`
 * matches the GPU path's aspect behavior — the silhouette fits inside the
 * container without distortion.
 */
export function StaticFallback({
  mark,
  color,
  opacity,
  className,
  style,
  ariaLabel,
}: StaticFallbackProps) {
  const d = markToSvgPath(mark);
  return (
    <svg
      className={className}
      style={{ width: '100%', height: '100%', display: 'block', ...style }}
      viewBox="-1 -1 2 2"
      preserveAspectRatio="xMidYMid meet"
      role={ariaLabel ? 'img' : 'presentation'}
      aria-label={ariaLabel}
    >
      <path d={d} fill={color} opacity={opacity} fillRule="evenodd" />
    </svg>
  );
}

function markToSvgPath(mark: Mark): string {
  const parts: string[] = [];
  for (const path of mark.paths) {
    if (path.length === 0) continue;
    const first = path[0]!;
    parts.push(`M ${fmt(first[0]!)} ${fmt(-first[1]!)}`);
    for (const seg of path) {
      parts.push(
        `C ${fmt(seg[2]!)} ${fmt(-seg[3]!)} ${fmt(seg[4]!)} ${fmt(-seg[5]!)} ${fmt(seg[6]!)} ${fmt(-seg[7]!)}`,
      );
    }
    parts.push('Z');
  }
  return parts.join(' ');
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : '0';
}
