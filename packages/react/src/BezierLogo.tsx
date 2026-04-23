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
import { reveal } from './effects/reveal';
import { ripple } from './effects/ripple';
import { liquidCursor } from './effects/liquid-cursor';
import type { EffectDefinition, EffectFrame, EffectRuntime } from './effects/types';

export type BezierLogoEffect = 'none' | 'reveal' | 'ripple' | 'liquid-cursor';

/**
 * `effect` accepts either a single preset name, or an array to compose
 * multiple presets simultaneously (e.g. `['liquid-cursor', 'ripple']` so
 * hover bulges toward the pointer and clicks fire a ripple through it).
 * Use `'none'` or omit the prop to disable effects entirely — `'none'`
 * is not allowed inside an array.
 */
export type BezierLogoEffectProp =
  | BezierLogoEffect
  | Array<Exclude<BezierLogoEffect, 'none'>>;

export interface BezierLogoHandle {
  /**
   * Reset the effect to its start state. For `reveal` this re-plays the
   * intro animation; for the reactive effects it's a no-op unless the
   * runtime opts in.
   */
  replay(): void;
}

export interface BezierLogoProps {
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
  effect?: BezierLogoEffectProp;
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
}

const DEFAULT_SMIN_K = 0.08;

const DEFINITIONS: Record<Exclude<BezierLogoEffect, 'none'>, EffectDefinition> = {
  'reveal': reveal,
  'ripple': ripple,
  'liquid-cursor': liquidCursor,
};

function zeroOffsets(n: number): Array<[number, number]> {
  return Array.from({ length: n }, () => [0, 0] as [number, number]);
}

function resolveDefinitions(prop: BezierLogoEffectProp): EffectDefinition[] {
  if (prop === 'none') return [];
  if (Array.isArray(prop)) {
    // De-duplicate — repeating a preset would double its contribution and
    // is almost certainly a bug.
    const seen = new Set<string>();
    const out: EffectDefinition[] = [];
    for (const name of prop) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(DEFINITIONS[name]);
    }
    return out;
  }
  return [DEFINITIONS[prop]];
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

/**
 * Drop-in GPU logo. Handles fetch, parse, normalization, DPR, resize,
 * WebGPU→WebGL→SVG fallback, optional intro and interactive effects, and
 * disposal on unmount.
 *
 * Client-only. For Next.js, wrap with `dynamic(..., { ssr: false })`.
 */
export const BezierLogo = forwardRef<BezierLogoHandle, BezierLogoProps>(function BezierLogo(
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
  });
  stateRef.current.color = color;
  stateRef.current.opacity = opacity;
  stateRef.current.perPath = perPath;
  stateRef.current.pauseWhenOffscreen = pauseWhenOffscreen;

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

    const defs = resolveDefinitions(effect);
    const needsPointer = defs.some((d) => d.needsPointer);
    const needsScroll = defs.some((d) => d.scrollTrigger);

    let cancelled = false;
    let renderer: Renderer | null = null;
    let runtimes: EffectRuntime[] = [];
    let ro: ResizeObserver | null = null;
    let io: IntersectionObserver | null = null;
    let pointerCleanup: (() => void) | null = null;
    state.visible = true;
    state.rafId = 0;

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
    sizeCanvas();

    const renderOnce = (now: number): boolean => {
      const r = renderer;
      if (!r) return true;
      const frame =
        runtimes.length > 0 ? mergeFrames(runtimes.map((rt) => rt.frame(now))) : null;
      const offsets = frame?.pathOffsets ?? zeroOffsets(r.pathCount);
      const base = state.perPath;

      // Rule: `color` tints only when the mark is all-fill paths (the
      // reveal example, single-color logos). The moment an SVG carries
      // a stroke anywhere, it's a "real" SVG — render it exactly as
      // drawn, `color` is ignored. Avoids recoloring an icon into
      // something its author didn't intend.
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

    (async () => {
      try {
        const result = await createRenderer(rendererKind, { canvas, mark });
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
      runtimes = defs.map((d) =>
        d.create({ pathCount: renderer!.pathCount, reducedMotion, autoPlay }),
      );

      // First frame — poised state (reveal) or a zeroed reactive frame.
      // Prevents the empty-canvas flash between renderer init and the
      // first event/rAF tick.
      renderOnce(performance.now());

      // Resize.
      ro = new ResizeObserver(() => {
        if (sizeCanvas()) renderOnce(performance.now());
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
      pointerCleanup?.();
      ro?.disconnect();
      io?.disconnect();
      renderer?.dispose();
      renderer = null;
      runtimes = [];
    };
  }, [mark, rendererKind, effect, autoPlay, onReady, onError]);

  /* --------------- 3. React to color/opacity changes mid-life -------------- */

  useEffect(() => {
    stateRef.current.requestRender();
  }, [color, opacity]);

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
