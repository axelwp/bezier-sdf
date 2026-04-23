import { normalizeMark, parseSvgPath, type Mark } from '@bezier-sdf/core';

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
    return parseSvgText(text);
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

/**
 * Parse an SVG document's text, extract every `<path>` element's `d`
 * attribute, merge into one Mark, and normalize into the renderer's
 * `[-1, 1]` space with Y flipped.
 *
 * Non-path elements (`<rect>`, `<circle>`, `<polygon>`) are ignored for
 * now — future versions may convert them. The renderer's 4-path ceiling
 * is enforced here so the error surfaces with a clear message instead of
 * from deep inside the shader init.
 */
function parseSvgText(text: string): Mark {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    throw new Error(`SVG parse error: ${parseErr.textContent?.trim() ?? 'unknown'}`);
  }
  const pathEls = Array.from(doc.querySelectorAll('path'));
  if (pathEls.length === 0) {
    throw new Error('SVG contains no <path> elements — convert shapes to paths first.');
  }

  const paths = [];
  for (const el of pathEls) {
    const d = el.getAttribute('d');
    if (!d) continue;
    const sub = parseSvgPath(d);
    for (const p of sub.paths) paths.push(p);
  }
  if (paths.length === 0) {
    throw new Error('SVG <path> elements had no usable `d` data.');
  }
  if (paths.length > 4) {
    throw new Error(
      `SVG has ${paths.length} paths but @bezier-sdf/core supports at most 4. ` +
        'Merge smaller paths together in your vector editor.',
    );
  }

  return normalizeMark({ paths }).mark;
}
