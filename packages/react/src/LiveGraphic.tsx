import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  createRenderer,
  type Mark,
  type PathMode,
  type Renderer,
  type RgbColor,
} from '@bezier-sdf/core';
import { loadMark } from './svg-cache';
import { parseColor } from './parseColor';
import { StaticFallback } from './StaticFallback';
import { reveal, type RevealParams } from './effects/reveal';
import { ripple, type RippleParams } from './effects/ripple';
import { liquidCursor, type LiquidCursorParams } from './effects/liquid-cursor';
import { DEFAULT_GLASS_PARAMS, type LiquidGlassParams } from './effects/liquid-glass';
import type { EffectDefinition, EffectFrame, EffectRuntime } from './effects/types';

export type LiveGraphicEffect = 'none' | 'reveal' | 'ripple' | 'liquid-cursor' | 'liquid-glass';

export type LiveGraphicEffectName = Exclude<LiveGraphicEffect, 'none'>;

/**
 * Object form: name + tuning knobs for that effect. Allows composition
 * with different params per preset in the array form of `effect`.
 */
export type LiveGraphicEffectSpec =
  | ({ name: 'reveal' } & RevealParams)
  | ({ name: 'ripple' } & RippleParams)
  | ({ name: 'liquid-cursor' } & LiquidCursorParams)
  | ({ name: 'liquid-glass' } & LiquidGlassParams);

/** Accepted shapes for the backdrop prop consumed in liquid-glass mode. */
export type LiveGraphicBackdrop = string | HTMLImageElement | HTMLCanvasElement | ImageBitmap;

/**
 * `effect` accepts: a single preset name, a single spec object, or an
 * array mixing names and spec objects (e.g. `['liquid-cursor', 'ripple']`
 * or `[{ name: 'ripple', speed: 3.5 }, 'liquid-cursor']`). Use `'none'`
 * or omit the prop to disable effects entirely — `'none'` is not allowed
 * inside an array.
 */
export type LiveGraphicEffectProp =
  | LiveGraphicEffect
  | LiveGraphicEffectSpec
  | Array<LiveGraphicEffectName | LiveGraphicEffectSpec>;

export interface LiveGraphicHandle {
  /**
   * Reset the effect to its start state. For `reveal` this re-plays the
   * intro animation; for the reactive effects it's a no-op unless the
   * runtime opts in.
   */
  replay(): void;
}

export interface LiveGraphicProps {
  /** URL (or data URI) of the SVG to trace. */
  src: string;
  /**
   * Optional global color override. When set, every path is painted with
   * this color (smooth-union mode, matches the reveal example). Omit to
   * honor the SVG's own per-path fill/stroke colors.
   */
  color?: string;
  /** 0..1 opacity multiplier applied on top of any effect opacity. */
  opacity?: number;
  /**
   * Which effect preset(s) to run. Pass a single name, or an array to
   * compose (e.g. `['liquid-cursor', 'ripple']`). Default `'none'`.
   */
  effect?: LiveGraphicEffectProp;
  /**
   * For `effect='reveal'`: start the animation immediately on mount. When
   * `false` (default), the animation waits for the component to scroll
   * into view, then plays once. `replay()` re-triggers it regardless.
   * Ignored by reactive effects (`ripple`, `liquid-cursor`).
   */
  autoPlay?: boolean;
  /** Force a specific backend; default `'auto'` (WebGPU → WebGL). */
  renderer?: 'auto' | 'webgpu' | 'webgl';
  /** Fires once the GPU renderer is live. */
  onReady?: (info: { kind: 'webgpu' | 'webgl' }) => void;
  /** Fires on fetch/parse errors *and* on both-backends-failed. */
  onError?: (error: Error) => void;
  /** Cancel rAF while the element is offscreen. Default `true`. */
  pauseWhenOffscreen?: boolean;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  /**
   * Image to refract through the shape when `effect` includes
   * `'liquid-glass'` or `material === 'glass'`. Accepts a URL (fetched with
   * `crossOrigin=anonymous`) or a ready `HTMLImageElement` /
   * `HTMLCanvasElement` / `ImageBitmap`.
   *
   * Static-only for now: the renderer uploads this once at init. Changing
   * the value triggers a renderer re-init. Ignored unless glass is
   * active.
   *
   * Aspect: the image is center-cropped (CSS `cover` behavior) to the
   * canvas aspect before being sampled by the shader. For the content
   * inside the lens to line up with whatever you paint behind the
   * canvas, render that visible layer with the same cover-crop against
   * a box that matches the canvas's on-screen rect (e.g. `<img
   * style={{objectFit: 'cover'}}>` at canvas size, or a `background-size:
   * cover; background-position: center` on a canvas-sized element).
   */
  backdrop?: LiveGraphicBackdrop;
  /**
   * Gaussian blur (in CSS pixels of the display canvas) applied to the
   * backdrop after it's resized to match the canvas's backing-store
   * dimensions. The shader samples the blurred texture — refraction over
   * high-frequency input (photos, textures) otherwise reads as noisy
   * smearing because adjacent pixels sample unrelated backdrop detail.
   * Pre-blurring attenuates that high-frequency content so refraction
   * reads as smooth warping.
   *
   * Default `6`: frosted-glass feel on photos, only a faint softening on
   * abstract backdrops. Set to `0` for crisp refraction (best for
   * gradients, grids, UI screenshots). Higher values (`10`–`16`) push
   * further toward heavy frosting.
   *
   * Re-applied whenever the canvas resizes, so the kernel radius remains
   * correct in display-space. Ignored unless glass is active.
   */
  backdropBlur?: number;
  /**
   * Switch the silhouette pipeline to a material shader. `'glass'` renders
   * the shape as a refractive liquid-glass lens (requires `backdrop`).
   *
   * Unlike `effect='liquid-glass'`, this prop *composes* with frame-based
   * effects: pair it with `effect='liquid-cursor'` or `'ripple'` to get a
   * glass lens that also deforms around the pointer. Glass params can be
   * tuned by passing a `liquid-glass` spec in the `effect` array alongside
   * the material.
   */
  material?: 'glass';
}

// Soft-union radius used by the legacy single-color shader branch. Kept
// low enough to be imperceptible across the typical gap between distinct
// `<path>` elements in an icon SVG — e.g. the ~1–3% gaps between a gene-
// icon's connector lines and hexagons used to blob together at the old
// 0.08 default. Effects that *want* visible rubber-band union (reveal's
// morph-into-one-silhouette animation) set their own sminK in effect
// frames, so this only governs the "no effects, just tint" case.
const DEFAULT_SMIN_K = 0.005;

/**
 * Effect definitions for frame-based effects. `liquid-glass` is
 * deliberately not here — it's a material (different sample pipeline),
 * not a frame-modulating runtime, and follows an entirely separate
 * mount path below.
 */
const DEFINITIONS: Record<Exclude<LiveGraphicEffectName, 'liquid-glass'>, EffectDefinition> = {
  'reveal': reveal,
  'ripple': ripple,
  'liquid-cursor': liquidCursor,
};

function zeroOffsets(n: number): Array<[number, number]> {
  return Array.from({ length: n }, () => [0, 0] as [number, number]);
}

interface ResolvedSpec {
  def: EffectDefinition;
  params?: Record<string, number>;
}

function specToEntry(
  item: LiveGraphicEffectName | LiveGraphicEffectSpec,
): { name: LiveGraphicEffectName; params?: Record<string, number> } {
  if (typeof item === 'string') return { name: item };
  const { name, ...rest } = item;
  const params = rest as Record<string, number>;
  return { name, params: Object.keys(params).length ? params : undefined };
}

function resolveSpecs(prop: LiveGraphicEffectProp): ResolvedSpec[] {
  if (prop === 'none') return [];
  const items: Array<LiveGraphicEffectName | LiveGraphicEffectSpec> = Array.isArray(prop)
    ? prop
    : typeof prop === 'string'
      ? [prop as LiveGraphicEffectName]
      : [prop];
  // De-duplicate by name — repeating a preset would double its contribution.
  // liquid-glass is handled separately (different pipeline entirely), so
  // it's dropped from the frame-based effect list here.
  const seen = new Set<string>();
  const out: ResolvedSpec[] = [];
  for (const item of items) {
    const { name, params } = specToEntry(item);
    if (name === 'liquid-glass') continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ def: DEFINITIONS[name], params });
  }
  return out;
}

/**
 * Pick the glass spec out of the effect prop, ignoring other specs. When
 * glass is combined with a frame-based effect, this returns the glass
 * spec and the caller decides (we warn and render glass-only — see
 * `extractGlassSpec` call site).
 */
function extractGlassSpec(prop: LiveGraphicEffectProp): LiquidGlassParams | null {
  if (prop === 'none') return null;
  const items: Array<LiveGraphicEffectName | LiveGraphicEffectSpec> = Array.isArray(prop)
    ? prop
    : typeof prop === 'string'
      ? [prop as LiveGraphicEffectName]
      : [prop];
  for (const item of items) {
    if (item === 'liquid-glass') return {};
    if (typeof item === 'object' && 'name' in item && item.name === 'liquid-glass') {
      const { name: _name, ...rest } = item;
      return rest as LiquidGlassParams;
    }
  }
  return null;
}

/** Stable identity key for the useEffect dep — names only, sorted. */
function effectNamesKey(prop: LiveGraphicEffectProp): string {
  const glass = extractGlassSpec(prop) ? ['liquid-glass'] : [];
  const frame = resolveSpecs(prop).map((s) => s.def.name);
  return [...glass, ...frame].sort().join(',');
}

/** Extract per-effect params map for live updates. */
function effectParamsMap(prop: LiveGraphicEffectProp): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const { def, params } of resolveSpecs(prop)) {
    if (params) out[def.name] = params;
  }
  return out;
}

/**
 * Merge effect frames into one. Rules were picked so the built-in presets
 * compose as you'd expect: reveal owns `pathOffsets`, liquid-cursor owns
 * `cursor*`, ripple owns `ripples`. `opacity` multiplies across effects
 * so (say) a reveal fade-in on top of a hover tint layers correctly. For
 * fields only one effect writes, "last defined wins" is effectively "the
 * one that wrote it wins."
 */
function mergeFrames(frames: EffectFrame[]): EffectFrame {
  const out: EffectFrame = {};
  for (const f of frames) {
    if (f.pathOffsets !== undefined) out.pathOffsets = f.pathOffsets;
    if (f.opacity !== undefined) out.opacity = (out.opacity ?? 1) * f.opacity;
    if (f.sminK !== undefined) out.sminK = f.sminK;
    if (f.cursor !== undefined) out.cursor = f.cursor;
    if (f.cursorPull !== undefined) out.cursorPull = f.cursorPull;
    if (f.cursorRadius !== undefined) out.cursorRadius = f.cursorRadius;
    if (f.ripples !== undefined) out.ripples = f.ripples;
  }
  return out;
}

/**
 * Canvas client coords → SDF space `[-1, 1]`, matching the transform used
 * by both shader backends at `zoom=1, offset=0`. Keep this in sync with
 * the shader if baseline zoom/offset ever change.
 */
function eventToSdfSpace(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const px = (clientX - rect.left) * (canvas.width / rect.width);
  const py = (clientY - rect.top) * (canvas.height / rect.height);
  const m = Math.min(canvas.width, canvas.height);
  return [
    ((px - 0.5 * canvas.width) / m) * 2,
    ((0.5 * canvas.height - py) / m) * 2,
  ];
}

interface PerPathUniforms {
  pathModes: PathMode[];
  pathStrokeHalfW: number[];
  pathFillColors: RgbColor[];
  pathStrokeColors: RgbColor[];
  pathFillOpacity: number[];
  pathStrokeOpacity: number[];
}

function buildPerPath(mark: Mark): PerPathUniforms {
  return {
    pathModes: mark.paths.map((p) => p.mode),
    // shader expects half-width.
    pathStrokeHalfW: mark.paths.map((p) => p.strokeWidth * 0.5),
    pathFillColors: mark.paths.map((p) => p.fillColor),
    pathStrokeColors: mark.paths.map((p) => p.strokeColor),
    pathFillOpacity: mark.paths.map((p) => p.fillOpacity),
    pathStrokeOpacity: mark.paths.map((p) => p.strokeOpacity),
  };
}

/* ============================== liquid-glass ============================== */

/**
 * Resolve a raw `<LiveGraphic backdrop>` value into a TexImageSource ready
 * to hand to the renderer. URL strings become `HTMLImageElement` fetched
 * with `crossOrigin='anonymous'`; passed-in elements/bitmaps are awaited
 * for decode if they're not ready yet.
 *
 * CORS: the browser silently taints canvases built from cross-origin
 * images that lack CORS headers; subsequent `texImage2D` / `copyExternal-
 * ImageToTexture` throws `SecurityError`. We proactively set
 * `crossOrigin='anonymous'` so the browser sends a CORS request; if the
 * server doesn't respond with `Access-Control-Allow-Origin`, the load
 * fails fast with a readable error instead of later at upload time.
 */
async function loadBackdrop(src: LiveGraphicBackdrop): Promise<TexImageSource> {
  if (typeof src === 'string') {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () =>
        reject(new Error(
          `liquid-glass: failed to load backdrop "${src}". ` +
          'The image must be same-origin or served with CORS headers.',
        ));
      img.src = src;
    });
  }
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement && !src.complete) {
    await new Promise<void>((res, rej) => {
      src.addEventListener('load',  () => res(), { once: true });
      src.addEventListener('error', () => rej(new Error('liquid-glass: backdrop image failed to load')), { once: true });
    });
  }
  return src;
}

/** Native pixel dimensions across the three backdrop source shapes. */
function sourceSize(
  src: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
): { w: number; h: number } {
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
    return { w: src.naturalWidth || src.width, h: src.naturalHeight || src.height };
  }
  return { w: src.width, h: src.height };
}

/**
 * Resize the backdrop to match the display canvas, then (optionally)
 * Gaussian-blur it. Refraction sampling reads a different pixel per
 * destination fragment; on a high-frequency backdrop those neighboring
 * lookups land on unrelated detail and refraction reads as noise.
 * Blurring attenuates that high-frequency content so the shader produces
 * smooth warping instead.
 *
 * Resize-first matters: Canvas 2D `filter: blur(Npx)` is specified in CSS
 * pixels of the *destination*. If we blur at source resolution (say,
 * 4000px wide) and then downscale, an `Npx` blur there is a sub-pixel
 * blur in display space — barely visible. Resizing first puts the blur
 * kernel in the same coordinate space as the final display.
 *
 * Two canvases deliberately: blurring in-place on the resized canvas
 * (re-using the same `drawImage` target) sometimes reads the pre-blur
 * pixels because the browser treats the canvas as both source and
 * destination of its own filter — safer to blur from one canvas into
 * another.
 *
 * Aspect handling: the resize is a center-cropped *cover* — the source
 * is scaled proportionally to fill the target box and trimmed on the
 * long axis. The glass shader samples backdrop UVs `0..1` straight from
 * the canvas fragment coordinate, so a stretched texture would render
 * squashed content inside the lens that doesn't line up with whatever
 * the user paints behind the canvas (typically the same image with
 * `background-size: cover` / `object-fit: cover` — also center-cropped).
 * Cover is the only choice that keeps the two views consistent without
 * requiring the caller to pre-crop; contain (letterbox) would leave
 * blank bars the user has no way to color-match to their scene.
 *
 * Runs once at init and again on canvas resize. Tens of ms for a 1080p
 * source; negligible on modern hardware, never per-frame.
 */
function prepareBackdrop(
  source: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  targetWidth: number,
  targetHeight: number,
  blurPx: number,
): HTMLCanvasElement {
  const { w: sw, h: sh } = sourceSize(source);
  // Source-rect (sx, sy, cropW, cropH) center-cropped to the target
  // aspect. Falls back to the full source when the source is degenerate
  // (zero-sized) so we never divide by zero and drawImage stays defined.
  const targetAspect = targetWidth / targetHeight;
  let cropW = sw;
  let cropH = sh;
  if (sw > 0 && sh > 0) {
    const sourceAspect = sw / sh;
    if (sourceAspect > targetAspect) {
      // Source wider than target → crop left/right.
      cropW = sh * targetAspect;
    } else if (sourceAspect < targetAspect) {
      // Source taller than target → crop top/bottom.
      cropH = sw / targetAspect;
    }
  }
  const sx = (sw - cropW) * 0.5;
  const sy = (sh - cropH) * 0.5;

  const resized = document.createElement('canvas');
  resized.width = targetWidth;
  resized.height = targetHeight;
  const rctx = resized.getContext('2d');
  if (!rctx) throw new Error('liquid-glass: 2D context unavailable for backdrop prep');
  rctx.imageSmoothingEnabled = true;
  rctx.imageSmoothingQuality = 'high';
  rctx.drawImage(
    source as CanvasImageSource,
    sx, sy, cropW, cropH,
    0, 0, targetWidth, targetHeight,
  );

  if (blurPx <= 0) return resized;

  const blurred = document.createElement('canvas');
  blurred.width = targetWidth;
  blurred.height = targetHeight;
  const bctx = blurred.getContext('2d');
  if (!bctx) throw new Error('liquid-glass: 2D context unavailable for backdrop blur');
  bctx.filter = `blur(${blurPx}px)`;
  bctx.drawImage(resized, 0, 0);
  return blurred;
}

interface GlassUniformShape {
  refractionStrength: number;
  chromaticStrength: number;
  fresnelStrength: number;
  tintStrength: number;
  frostStrength: number;
  rimColor: [number, number, number];
  tintColor: [number, number, number];
}

/** Merge a spec with defaults and parse CSS colors once per render. */
function resolveGlassUniforms(spec: LiquidGlassParams): GlassUniformShape {
  return {
    refractionStrength: spec.refractionStrength ?? DEFAULT_GLASS_PARAMS.refractionStrength,
    chromaticStrength:  spec.chromaticStrength  ?? DEFAULT_GLASS_PARAMS.chromaticStrength,
    fresnelStrength:    spec.fresnelStrength    ?? DEFAULT_GLASS_PARAMS.fresnelStrength,
    tintStrength:       spec.tintStrength       ?? DEFAULT_GLASS_PARAMS.tintStrength,
    frostStrength:      spec.frostStrength      ?? DEFAULT_GLASS_PARAMS.frostStrength,
    rimColor:  parseColor(spec.rimColor  ?? DEFAULT_GLASS_PARAMS.rimColor),
    tintColor: parseColor(spec.tintColor ?? DEFAULT_GLASS_PARAMS.tintColor),
  };
}

/**
 * Drop-in GPU logo. Handles fetch, parse, normalization, DPR, resize,
 * WebGPU→WebGL→SVG fallback, optional intro and interactive effects, and
 * disposal on unmount.
 *
 * Client-only. For Next.js, wrap with `dynamic(..., { ssr: false })`.
 */
export const LiveGraphic = forwardRef<LiveGraphicHandle, LiveGraphicProps>(function LiveGraphic(
  {
    src,
    color,
    opacity = 1,
    effect = 'none',
    autoPlay = false,
    renderer: rendererKind = 'auto',
    onReady,
    onError,
    pauseWhenOffscreen = true,
    className,
    style,
    ariaLabel,
    backdrop,
    backdropBlur = 6,
    material,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [mark, setMark] = useState<Mark | null>(null);
  const [fallback, setFallback] = useState(false);

  // Per-path uniforms derived from the mark. Stable across re-renders so
  // the rAF loop can read them without tearing.
  const perPath = useMemo(() => (mark ? buildPerPath(mark) : null), [mark]);

  // Latest props + mutable loop state. Updated on every render so the rAF
  // loop sees fresh color/opacity without forcing a re-init.
  const stateRef = useRef({
    color,
    opacity,
    perPath,
    pauseWhenOffscreen,
    rafId: 0,
    visible: true,
    replay: () => {},
    requestRender: () => {},
    pushParams: (_: Record<string, Record<string, number>>) => {},
  });
  stateRef.current.color = color;
  stateRef.current.opacity = opacity;
  stateRef.current.perPath = perPath;
  stateRef.current.pauseWhenOffscreen = pauseWhenOffscreen;

  // Stable primitive dep: mount only re-runs when the *set* of active
  // effects changes, not when their params do. Params flow through
  // `stateRef.pushParams` in a separate effect.
  const effectKey = useMemo(() => effectNamesKey(effect), [effect]);
  const paramsMap = useMemo(() => effectParamsMap(effect), [effect]);
  // Latest spec snapshot — read by the mount effect on (re-)init so new
  // runtimes pick up the current params.
  const effectRef = useRef(effect);
  effectRef.current = effect;

  useImperativeHandle(ref, () => ({
    replay: () => stateRef.current.replay(),
  }), []);

  /* ------------------------------ 1. Load SVG ------------------------------ */

  useEffect(() => {
    let cancelled = false;
    setMark(null);
    setFallback(false);
    loadMark(src).then(
      (m) => { if (!cancelled) setMark(m); },
      (err) => {
        if (cancelled) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      },
    );
    return () => { cancelled = true; };
  }, [src, onError]);

  /* ---------------------- 2. Init renderer + run loop ---------------------- */

  useEffect(() => {
    if (!mark) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const state = stateRef.current;
    const reducedMotion =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

    const sizeCanvas = (): boolean => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width === w && canvas.height === h) return false;
      canvas.width = w;
      canvas.height = h;
      return true;
    };

    // Glass can be requested two ways: the `material='glass'` prop (new,
    // composes with other effects) or the legacy `effect='liquid-glass'`
    // spec (back-compat). Both take glass params from any embedded
    // liquid-glass effect spec; the material prop alone uses defaults.
    const glassSpec = extractGlassSpec(effectRef.current);
    const glassMode = material === 'glass' || glassSpec !== null;
    if (glassMode && !backdrop) {
      const err = new Error(
        'liquid-glass material requires a `backdrop` prop (URL or HTMLImageElement/HTMLCanvasElement/ImageBitmap)',
      );
      onError?.(err);
      setFallback(true);
      return;
    }

    // Snapshot current specs at mount. Param-only changes don't re-run
    // this effect (see `effectKey` dep); they flow in via `pushParams`.
    const specs = resolveSpecs(effectRef.current);
    const defs = specs.map((s) => s.def);
    const needsPointer = defs.some((d) => d.needsPointer);
    const needsScroll = defs.some((d) => d.scrollTrigger);
    const hasReveal = defs.some((d) => d.name === 'reveal');

    let cancelled = false;
    let renderer: Renderer | null = null;
    let runtimes: EffectRuntime[] = [];
    let ro: ResizeObserver | null = null;
    let io: IntersectionObserver | null = null;
    let pointerCleanup: (() => void) | null = null;
    state.visible = true;
    state.rafId = 0;

    sizeCanvas();

    const renderOnce = (now: number): boolean => {
      const r = renderer;
      if (!r) return true;
      const frame =
        runtimes.length > 0 ? mergeFrames(runtimes.map((rt) => rt.frame(now))) : null;
      const offsets = frame?.pathOffsets ?? zeroOffsets(r.pathCount);
      const base = state.perPath;

      if (glassMode) {
        // Glass pipeline — shape is a material, not a painter. Per-path
        // colors/opacities are ignored (smooth-union silhouette), but
        // pathModes + pathStrokeHalfW ARE forwarded so stroked paths
        // enter the glass shader as their sausage SDF (abs(d) - halfW)
        // rather than being collapsed into solid silhouettes. Without
        // this a line-icon SVG renders as a filled blob, not glass
        // tubes. pathOffsets, cursor, and ripple fields from the frame
        // flow through so the lens geometry animates (reveal) and
        // deforms (cursor/ripple).
        const spec = extractGlassSpec(effectRef.current) ?? {};
        const gu = resolveGlassUniforms(spec);
        const base = state.perPath;
        r.render({
          width: canvas.width,
          height: canvas.height,
          zoom: 1,
          sminK: frame?.sminK ?? DEFAULT_SMIN_K,
          offsetX: 0,
          offsetY: 0,
          pathOffsets: offsets,
          color: [0, 0, 0],
          opacity: (frame?.opacity ?? 1) * state.opacity,
          cursor: frame?.cursor,
          cursorPull: frame?.cursorPull,
          cursorRadius: frame?.cursorRadius,
          ripples: frame?.ripples,
          pathModes: base?.pathModes,
          pathStrokeHalfW: base?.pathStrokeHalfW,
          glass: true,
          refractionStrength: gu.refractionStrength,
          chromaticStrength:  gu.chromaticStrength,
          fresnelStrength:    gu.fresnelStrength,
          tintStrength:       gu.tintStrength,
          frostStrength:      gu.frostStrength,
          rimColor:           gu.rimColor,
          tintColor:          gu.tintColor,
        });
        return runtimes.some((rt) => rt.active(now));
      }

      // Rule: `color` tints only when the mark is all-fill paths (the
      // reveal example, single-color logos). The moment an SVG carries
      // a stroke anywhere, it's a "real" SVG — render it exactly as
      // drawn, `color` is ignored. Avoids recoloring an icon into
      // something its author didn't intend.
      //
      // Reveal on a multi-subpath user SVG does smin-union the subpaths
      // into one silhouette, which can produce visible bridging blobs
      // between subpaths that shouldn't touch. That's a deliberate
      // trade the caller opts into by providing `color`: the explicit
      // tint signals "render this as one shape in one color," which is
      // the legacy-smin aesthetic regardless of source. Callers who
      // want preserved subpath structure simply omit `color`.
      const allFill = base ? base.pathModes.every((m) => m === 'fill') : true;
      const useLegacy = allFill && state.color !== undefined;

      if (useLegacy) {
        const [cr, cg, cb] = parseColor(state.color!);
        r.render({
          width: canvas.width,
          height: canvas.height,
          zoom: 1,
          sminK: frame?.sminK ?? DEFAULT_SMIN_K,
          offsetX: 0,
          offsetY: 0,
          pathOffsets: offsets,
          color: [cr, cg, cb],
          opacity: (frame?.opacity ?? 1) * state.opacity,
          cursor: frame?.cursor,
          cursorPull: frame?.cursorPull,
          cursorRadius: frame?.cursorRadius,
          ripples: frame?.ripples,
        });
      } else {
        // Per-path composite using the SVG's own paint. `color` is
        // intentionally ignored here.
        const perPath = base ?? {
          pathModes: [] as PathMode[],
          pathStrokeHalfW: [] as number[],
          pathFillColors: [] as RgbColor[],
          pathStrokeColors: [] as RgbColor[],
          pathFillOpacity: [] as number[],
          pathStrokeOpacity: [] as number[],
        };
        r.render({
          width: canvas.width,
          height: canvas.height,
          zoom: 1,
          sminK: frame?.sminK ?? DEFAULT_SMIN_K,
          offsetX: 0,
          offsetY: 0,
          pathOffsets: offsets,
          color: [0, 0, 0],
          opacity: (frame?.opacity ?? 1) * state.opacity,
          cursor: frame?.cursor,
          cursorPull: frame?.cursorPull,
          cursorRadius: frame?.cursorRadius,
          ripples: frame?.ripples,
          pathModes: perPath.pathModes,
          pathStrokeHalfW: perPath.pathStrokeHalfW,
          pathFillColors: perPath.pathFillColors,
          pathStrokeColors: perPath.pathStrokeColors,
          pathFillOpacity: perPath.pathFillOpacity,
          pathStrokeOpacity: perPath.pathStrokeOpacity,
        });
      }
      return runtimes.some((rt) => rt.active(now));
    };

    const tick = (now: number) => {
      const stillActive = renderOnce(now);
      if (stillActive && (state.visible || !state.pauseWhenOffscreen)) {
        state.rafId = requestAnimationFrame(tick);
      } else {
        state.rafId = 0;
      }
    };

    const startLoop = () => {
      if (state.rafId !== 0) return;
      if (!state.visible && state.pauseWhenOffscreen) return;
      state.rafId = requestAnimationFrame(tick);
    };

    state.requestRender = () => {
      // Single-frame render at current state — for color/opacity changes
      // that don't affect the animation timeline.
      renderOnce(performance.now());
    };

    state.replay = () => {
      const now = performance.now();
      for (const rt of runtimes) rt.replay?.(now);
      startLoop();
    };

    // Kept across the whole mount so the resize observer can re-prepare
    // the backdrop at the new canvas size without re-fetching the image.
    let rawBackdrop: HTMLImageElement | HTMLCanvasElement | ImageBitmap | null = null;
    let preparedW = 0;
    let preparedH = 0;

    // Prepare at the canvas's current backing-store size, if that size
    // is usable. Returns `null` when the canvas hasn't been laid out yet
    // (1×1 fallback from sizeCanvas) or when a prep at that exact size
    // has already been uploaded. Caller decides whether this becomes the
    // initial backdrop or a later `setBackdrop` payload.
    const prepareAtCurrentSize = (): HTMLCanvasElement | null => {
      if (!rawBackdrop) return null;
      const tw = canvas.width;
      const th = canvas.height;
      if (tw <= 1 || th <= 1) return null;
      if (tw === preparedW && th === preparedH) return null;
      const prepared = prepareBackdrop(rawBackdrop, tw, th, backdropBlur);
      preparedW = tw;
      preparedH = th;
      return prepared;
    };

    (async () => {
      let backdropSrc: TexImageSource | undefined;
      if (glassMode && backdrop) {
        try {
          const loaded = await loadBackdrop(backdrop);
          if (cancelled) return;
          // loadBackdrop's return type is TexImageSource, but in practice
          // it only yields the three shapes `LiveGraphicBackdrop` exposes
          // — which is also the set `prepareBackdrop` accepts.
          rawBackdrop = loaded as HTMLImageElement | HTMLCanvasElement | ImageBitmap;
        } catch (err) {
          if (cancelled) return;
          onError?.(err instanceof Error ? err : new Error(String(err)));
          setFallback(true);
          return;
        }
        sizeCanvas();
        // If the canvas hasn't been laid out yet (no container size),
        // seed the renderer with the raw image so the glass pipeline
        // still compiles; the first ResizeObserver callback will swap in
        // a properly-sized, properly-blurred backdrop via setBackdrop.
        backdropSrc = prepareAtCurrentSize() ?? rawBackdrop;
      }

      try {
        const result = await createRenderer(rendererKind, {
          canvas,
          mark,
          backdrop: backdropSrc,
        });
        if (cancelled) {
          result.renderer.dispose();
          return;
        }
        renderer = result.renderer;
        onReady?.({ kind: result.actualKind });
      } catch (err) {
        if (cancelled) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
        setFallback(true);
        return;
      }

      // Create runtimes now that we know pathCount.
      runtimes = specs.map((s) =>
        s.def.create({ pathCount: renderer!.pathCount, reducedMotion, autoPlay, params: s.params }),
      );

      state.pushParams = (next) => {
        for (let i = 0; i < runtimes.length; i++) {
          const name = defs[i]!.name;
          runtimes[i]!.setParams?.(next[name] ?? {});
        }
        // Nudge a frame so static-state effects (e.g. reveal at rest) pick up changes.
        renderOnce(performance.now());
      };

      // First frame — poised state (reveal) or a zeroed reactive frame.
      // Prevents the empty-canvas flash between renderer init and the
      // first event/rAF tick.
      renderOnce(performance.now());

      // Resize. A display-size change invalidates the pre-blurred backdrop
      // (the blur kernel is specified in display-space pixels), so re-prep
      // and push it through `setBackdrop` before the next render. No GPU
      // work per frame — `prepareAtCurrentSize` early-exits when the size
      // hasn't actually changed.
      ro = new ResizeObserver(() => {
        if (!sizeCanvas()) return;
        if (glassMode && renderer && rawBackdrop) {
          const reprepped = prepareAtCurrentSize();
          if (reprepped) renderer.setBackdrop(reprepped);
        }
        renderOnce(performance.now());
      });
      ro.observe(container);

      // Pointer listeners fan out to every runtime that cares. Events are
      // cheap; we don't bother narrowing by per-runtime interest.
      if (needsPointer) {
        const onMove = (e: PointerEvent) => {
          const [x, y] = eventToSdfSpace(canvas, e.clientX, e.clientY);
          const now = performance.now();
          for (const rt of runtimes) rt.pointerMove?.(x, y, now);
          startLoop();
        };
        const onLeave = () => {
          const now = performance.now();
          for (const rt of runtimes) rt.pointerLeave?.(now);
          startLoop();
        };
        const onDown = (e: PointerEvent) => {
          const [x, y] = eventToSdfSpace(canvas, e.clientX, e.clientY);
          const now = performance.now();
          for (const rt of runtimes) rt.pointerDown?.(x, y, now);
          startLoop();
        };
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerleave', onLeave);
        canvas.addEventListener('pointerdown', onDown);
        canvas.style.touchAction = 'none'; // let pen/touch drive the effect without scroll-hijack
        pointerCleanup = () => {
          canvas.removeEventListener('pointermove', onMove);
          canvas.removeEventListener('pointerleave', onLeave);
          canvas.removeEventListener('pointerdown', onDown);
        };
      }

      // Scroll-trigger and pause-when-offscreen share one observer.
      const needsScrollTrigger = needsScroll && !autoPlay && !reducedMotion;
      if (needsScrollTrigger || pauseWhenOffscreen) {
        let scrollFired = false;
        io = new IntersectionObserver(
          (entries) => {
            const entry = entries[entries.length - 1];
            if (!entry) return;
            const visible = entry.isIntersecting;
            state.visible = visible;
            if (visible) {
              if (needsScrollTrigger && !scrollFired) {
                scrollFired = true;
                const now = performance.now();
                // Only trigger runtimes that are scroll-gated. Reactive
                // runtimes in the same composition shouldn't be "replayed"
                // by scrolling — their replay is a clear-state op.
                for (let i = 0; i < runtimes.length; i++) {
                  if (defs[i]!.scrollTrigger) runtimes[i]!.replay?.(now);
                }
              }
              startLoop();
            } else if (state.pauseWhenOffscreen && state.rafId !== 0) {
              cancelAnimationFrame(state.rafId);
              state.rafId = 0;
            }
          },
          { threshold: 0.01 },
        );
        io.observe(container);
      }

      // Immediate autoplay (or reduced-motion settle) for scroll-gated effects.
      if (needsScroll && (autoPlay || reducedMotion)) {
        const now = performance.now();
        for (let i = 0; i < runtimes.length; i++) {
          if (defs[i]!.scrollTrigger) runtimes[i]!.replay?.(now);
        }
        startLoop();
      }
    })();

    return () => {
      cancelled = true;
      if (state.rafId !== 0) cancelAnimationFrame(state.rafId);
      state.rafId = 0;
      state.requestRender = () => {};
      state.replay = () => {};
      state.pushParams = () => {};
      pointerCleanup?.();
      ro?.disconnect();
      io?.disconnect();
      renderer?.dispose();
      renderer = null;
      runtimes = [];
    };
  }, [mark, rendererKind, effectKey, autoPlay, onReady, onError, backdrop, backdropBlur, material]);

  /* --------------- 3. React to color/opacity changes mid-life -------------- */

  useEffect(() => {
    stateRef.current.requestRender();
  }, [color, opacity]);

  /* --------------- 4. Live-push effect param changes ----------------------- */

  useEffect(() => {
    stateRef.current.pushParams(paramsMap);
  }, [paramsMap]);

  // Glass params don't flow through the frame-based `paramsMap` pipeline
  // (there's no runtime to push to). JSON-stringify the spec so this
  // effect only fires when a value actually changes, not on every render.
  const glassParamsKey = useMemo(() => {
    const spec = extractGlassSpec(effect);
    return spec ? JSON.stringify(spec) : '';
  }, [effect]);
  useEffect(() => {
    if (glassParamsKey) stateRef.current.requestRender();
  }, [glassParamsKey]);

  /* ---------------------------------- UI ----------------------------------- */

  if (fallback && mark) {
    return (
      <div
        ref={containerRef}
        className={className}
        style={{ position: 'relative', ...style }}
        aria-label={ariaLabel}
        role={ariaLabel ? 'img' : undefined}
      >
        <StaticFallback
          mark={mark}
          color={color}
          opacity={opacity}
          style={{ position: 'absolute', inset: 0 }}
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: 'relative', ...style }}
      aria-label={ariaLabel}
      role={ariaLabel ? 'img' : undefined}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  );
});
