import { normalizeMark, parseSvgDocument, type Mark } from '@bezier-sdf/core';

/**
 * Cache of `src` → parsed, normalized Mark. Keyed by the exact `src` string
 * passed to `<BezierLogo>`, so mounting the same logo in three places fetches
 * and parses once.
 *
 * The promise is memoized, not the resolved value — that way concurrent
 * mounts all await the same in-flight fetch, and subsequent mounts (after
 * resolution) get the cached resolved Mark synchronously via the already-
 * settled promise.
 *
 * Failures are not cached. If a fetch fails we drop the entry so the next
 * mount retries — the alternative (caching the rejection) would lock out
 * dev hot-reloads where the src only becomes available after a moment.
 */
const cache = new Map<string, Promise<Mark>>();

export function loadMark(src: string): Promise<Mark> {
  const hit = cache.get(src);
  if (hit) return hit;

  const p = (async (): Promise<Mark> => {
    const res = await fetch(src);
    if (!res.ok) {
      throw new Error(`failed to fetch ${src}: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    const mark = parseSvgDocument(text);
    return normalizeMark(mark).mark;
  })();

  cache.set(src, p);
  p.catch(() => {
    // Evict failed fetches so retries work (see note above).
    if (cache.get(src) === p) cache.delete(src);
  });
  return p;
}

/** Visible mainly for tests and advanced users. */
export function clearSvgCache(): void {
  cache.clear();
}
