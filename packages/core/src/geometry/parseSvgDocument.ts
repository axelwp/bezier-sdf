import { parseSvgPath } from './parseSvgPath';
import { parseColor, parseColorAlpha } from './parseColor';
import { type CubicSegment, type Mark, type Path, type PathMode, type RgbColor, makePath } from './types';

export interface ParseSvgDocumentOptions {
  /**
   * Maximum number of `<path>` elements to return (one {@link Path} per
   * element, with multi-M subpaths merged). SVGs that exceed this cap
   * emit a `console.warn` naming the total and render only the first N
   * in source order — a broken component is worse than a partial one.
   * @default 16
   */
  maxPaths?: number;
  /**
   * Color used when a `<path>` resolves `fill` or `stroke` to `currentColor`.
   * In a browser this would be the CSS `color` of the containing element;
   * here it's a caller-provided default.
   * @default [0, 0, 0]
   */
  currentColor?: RgbColor;
}

/**
 * Parse an SVG document (as text) into a {@link Mark} carrying per-path
 * render metadata: fill/stroke mode, stroke width, colors, and opacities.
 *
 * SVG paint resolution is followed as closely as is reasonable for a
 * small parser:
 *
 *   - `fill` defaults to `#000` unless an ancestor sets it otherwise.
 *   - `stroke` defaults to `none`.
 *   - Attributes on `<path>` take precedence over attributes on ancestor
 *     `<g>` elements.
 *   - Inline `style="..."` takes precedence over attributes of the same
 *     name on the same element.
 *   - `fill="none"` / `stroke="none"` disable that paint.
 *
 * Unsupported features: `<style>` rules, CSS classes, `<use>`, pattern /
 * gradient paint servers, non-`<path>` shapes. These fall through to the
 * caller-provided `currentColor` or their SVG defaults.
 *
 * The renderer's per-pass 16-path cap is enforced by `maxPaths`. SVGs
 * that exceed it render a best-effort prefix and emit a `console.warn`
 * — common for line-icon libraries where an icon is many small strokes.
 *
 * Multi-subpath `<path>` elements (those whose `d` contains more than
 * one M/m) flatten to a single {@link Path} carrying the concatenated
 * cubic segments. The bake pass evaluates insideness with even-odd ray
 * crossings, which is what actually makes SVG's "outer + inner with
 * opposite winding" ring idiom work: one crossing in the donut (odd →
 * inside), two in the hole (even → outside). Splitting subpaths into
 * separate Paths would re-paint the hole in the same fill color and
 * collapse rings to solid disks; keeping them merged also renders
 * disjoint compound shapes correctly since each closed contour
 * contributes one crossing to points inside it and zero to points
 * outside.
 */
export function parseSvgDocument(text: string, options: ParseSvgDocumentOptions = {}): Mark {
  const { maxPaths = 16, currentColor = [0, 0, 0] as RgbColor } = options;

  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    throw new Error(`SVG parse error: ${parseErr.textContent?.trim() ?? 'unknown'}`);
  }
  const pathEls = Array.from(doc.querySelectorAll('path'));
  if (pathEls.length === 0) {
    throw new Error('SVG contains no <path> elements — convert shapes to paths first.');
  }

  const paths: Path[] = [];
  let skipped = 0;
  for (const el of pathEls) {
    const d = el.getAttribute('d');
    if (!d) continue;
    // Concatenate every subpath's segments into one segment list so the
    // shared bake pass sees the whole `<path>` as one shape (see doc
    // comment above — even-odd crossings do the hole / compound work
    // for free).
    const sub = parseSvgPath(d);
    const merged = sub.paths.flatMap((p) => p.segments as CubicSegment[]);
    if (merged.length === 0) continue;
    if (paths.length >= maxPaths) {
      skipped += 1;
      continue;
    }
    const meta = resolvePaintAttrs(el, currentColor);
    paths.push(makePath(merged, meta));
  }
  if (paths.length === 0) {
    throw new Error('SVG <path> elements had no usable `d` data.');
  }
  if (skipped > 0) {
    console.warn(
      `[bezier-sdf] SVG has ${paths.length + skipped} paths, exceeds renderer limit of ${maxPaths}. Rendering first ${maxPaths}.`,
    );
  }

  return { paths };
}

/** Walks element ancestors collecting fill/stroke/stroke-width/opacity. */
function resolvePaintAttrs(
  el: Element,
  currentColor: RgbColor,
): Partial<Omit<Path, 'segments'>> {
  let fillRaw: string | null = null;
  let strokeRaw: string | null = null;
  let strokeWidthRaw: string | null = null;
  let fillOpacityRaw: string | null = null;
  let strokeOpacityRaw: string | null = null;

  // Walk element + ancestors up to (but not including) the outer <svg>,
  // picking the nearest-set value for each attribute. Mirrors how the
  // browser resolves inherited paint properties.
  let cursor: Element | null = el;
  while (cursor && cursor.tagName.toLowerCase() !== 'svg') {
    const style = parseInlineStyle(cursor.getAttribute('style'));
    fillRaw          ??= style.fill          ?? cursor.getAttribute('fill');
    strokeRaw        ??= style.stroke        ?? cursor.getAttribute('stroke');
    strokeWidthRaw   ??= style['stroke-width']    ?? cursor.getAttribute('stroke-width');
    fillOpacityRaw   ??= style['fill-opacity']    ?? cursor.getAttribute('fill-opacity');
    strokeOpacityRaw ??= style['stroke-opacity']  ?? cursor.getAttribute('stroke-opacity');
    cursor = cursor.parentElement;
  }
  // SVG root can also carry these, and a top-level paint is common.
  if (cursor) {
    const style = parseInlineStyle(cursor.getAttribute('style'));
    fillRaw          ??= style.fill          ?? cursor.getAttribute('fill');
    strokeRaw        ??= style.stroke        ?? cursor.getAttribute('stroke');
    strokeWidthRaw   ??= style['stroke-width']    ?? cursor.getAttribute('stroke-width');
    fillOpacityRaw   ??= style['fill-opacity']    ?? cursor.getAttribute('fill-opacity');
    strokeOpacityRaw ??= style['stroke-opacity']  ?? cursor.getAttribute('stroke-opacity');
  }

  // Apply SVG's paint defaults: fill defaults to black, stroke to none.
  const fillColor   = fillRaw   === null ? ([0, 0, 0] as RgbColor) : resolveColor(fillRaw, currentColor);
  const strokeColor = strokeRaw === null ? null                     : resolveColor(strokeRaw, currentColor);

  const hasFill   = fillColor !== null;
  const hasStroke = strokeColor !== null;
  const mode: PathMode = hasFill && hasStroke ? 'both' : hasStroke ? 'stroke' : 'fill';

  const strokeWidth = strokeWidthRaw !== null ? parseFloat(strokeWidthRaw) : 1;
  const fillOpacity   = fillOpacityRaw   !== null ? clamp01(parseFloat(fillOpacityRaw))   : 1;
  const strokeOpacity = strokeOpacityRaw !== null ? clamp01(parseFloat(strokeOpacityRaw)) : 1;

  // Also honor hex/rgba alpha embedded in the color string itself.
  const fillAlpha   = fillRaw   !== null ? parseColorAlpha(fillRaw)   : 1;
  const strokeAlpha = strokeRaw !== null ? parseColorAlpha(strokeRaw) : 1;

  return {
    mode,
    strokeWidth: isFinite(strokeWidth) ? strokeWidth : 1,
    fillColor:   fillColor   ?? [0, 0, 0],
    strokeColor: strokeColor ?? [0, 0, 0],
    fillOpacity:   fillOpacity * fillAlpha,
    strokeOpacity: strokeOpacity * strokeAlpha,
  };
}

function resolveColor(css: string, currentColor: RgbColor): RgbColor | null {
  const s = css.trim().toLowerCase();
  if (s === 'none' || s === 'transparent') return null;
  if (s === 'currentcolor') return currentColor;
  const parsed = parseColor(css);
  // Unrecognized color falls back to black — SVG's spec says so, and it
  // makes broken input visible instead of silently invisible.
  return parsed ?? [0, 0, 0];
}

function parseInlineStyle(style: string | null): Record<string, string | undefined> {
  if (!style) return {};
  const out: Record<string, string> = {};
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const k = decl.slice(0, idx).trim().toLowerCase();
    const v = decl.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function clamp01(v: number): number {
  if (!isFinite(v)) return 1;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
