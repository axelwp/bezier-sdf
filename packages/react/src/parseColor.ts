import { parseColor as coreParse } from '@bezier-sdf/core';

/**
 * Wrapper around core's {@link coreParse} that always returns a triple —
 * `null` from core (meaning `none` / `transparent` / unrecognized) maps
 * to `[0, 0, 0]` so the caller can treat it as a black silhouette rather
 * than dealing with the no-paint case separately.
 */
export function parseColor(css: string): [number, number, number] {
  const c = coreParse(css);
  if (!c) return [0, 0, 0];
  return [c[0], c[1], c[2]];
}
