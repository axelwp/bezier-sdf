/**
 * Parse a CSS color string into an sRGB triple in 0..1. Uses the browser's
 * own CSS color parser via a throwaway Canvas 2D context so every format
 * the platform supports (`#rgb`, `#rrggbb`, `rgb()`, `hsl()`, named colors,
 * `color(display-p3 ...)`, etc.) round-trips to a normalized `#rrggbb`.
 *
 * Returns `[0, 0, 0]` when parsing fails — matches how the browser would
 * render `color: bogus` (it falls back silently). Unusable inputs are
 * therefore visible as a black silhouette rather than a crash.
 */
let parseCtx: CanvasRenderingContext2D | null = null;

export function parseColor(css: string): [number, number, number] {
  // Hex fast path — avoids creating a canvas for the common case.
  const hex = parseHex(css);
  if (hex) return hex;

  if (typeof document === 'undefined') return [0, 0, 0];
  if (!parseCtx) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    parseCtx = c.getContext('2d');
  }
  if (!parseCtx) return [0, 0, 0];

  // Seed to a known value so an unparseable input leaves the previous
  // fillStyle in place, which we detect below.
  parseCtx.fillStyle = '#000';
  parseCtx.fillStyle = css;
  const normalized = String(parseCtx.fillStyle);
  return parseHex(normalized) ?? parseRgba(normalized) ?? [0, 0, 0];
}

function parseHex(s: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1]!;
  if (h.length === 3 || h.length === 4) {
    return [
      parseInt(h[0]! + h[0]!, 16) / 255,
      parseInt(h[1]! + h[1]!, 16) / 255,
      parseInt(h[2]! + h[2]!, 16) / 255,
    ];
  }
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function parseRgba(s: string): [number, number, number] | null {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
  if (!m) return null;
  return [
    Math.min(1, Math.max(0, parseFloat(m[1]!) / 255)),
    Math.min(1, Math.max(0, parseFloat(m[2]!) / 255)),
    Math.min(1, Math.max(0, parseFloat(m[3]!) / 255)),
  ];
}
