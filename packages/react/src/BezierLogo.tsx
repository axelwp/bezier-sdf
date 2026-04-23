import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  createRenderer,
  type Mark,
  type Renderer,
} from '@bezier-sdf/core';
import { loadMark } from './svg-cache';
import { parseColor } from './parseColor';
import { StaticFallback } from './StaticFallback';
import { reveal as revealEffect } from './effects/reveal';
import type { Effect, EffectFrame } from './effects/types';

export type BezierLogoEffect = 'none' | 'reveal';

export interface BezierLogoHandle {
  /**
   * Re-run the current effect from the start. If `effect` is `'none'` or
   * the user prefers reduced motion, `replay()` is a no-op.
   */
  replay(): void;
}

export interface BezierLogoProps {
  /** URL (or data URI) of the SVG to trace. */
  src: string;
  /** Any CSS color string. Defaults to `#000`. */
  color?: string;
  /** 0..1 opacity multiplier applied on top of any effect opacity. */
  opacity?: number;
  /** Which intro effect to play. Default `'none'`. */
  effect?: BezierLogoEffect;
  /**
   * For `effect='reveal'`: start the animation immediately on mount. When
   * `false` (default), the animation waits for the component to scroll
   * into view, then plays once. `replay()` on the imperative handle
   * re-triggers it regardless.
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

const EFFECTS: Record<Exclude<BezierLogoEffect, 'none'>, Effect> = {
  reveal: revealEffect,
};

function zeroOffsets(n: number): Array<[number, number]> {
  return Array.from({ length: n }, () => [0, 0] as [number, number]);
}

/**
 * Drop-in GPU logo. Handles fetch, parse, normalization, DPR, resize,
 * WebGPU→WebGL→SVG fallback, and optional intro animations. Unmounting
 * disposes the renderer and cancels any in-flight frame.
 *
 * Client-only. For Next.js, wrap with `dynamic(..., { ssr: false })`.
 */
export const BezierLogo = forwardRef<BezierLogoHandle, BezierLogoProps>(function BezierLogo(
  {
    src,
    color = '#000',
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

  // Latest props visible to the rAF loop without re-triggering the init
  // effect. Animation trigger state is kept here too so `replay()` and the
  // IntersectionObserver can reach it.
  const stateRef = useRef({
    color,
    opacity,
    effect,
    autoPlay,
    pauseWhenOffscreen,
    triggered: effect === 'none',
    effectStart: 0,
    rafId: 0,
    visible: true,
    reducedMotion: false,
    requestRender: () => {},
    replay: () => {},
  });

  // Keep the ref in sync with the current props on every render.
  stateRef.current.color = color;
  stateRef.current.opacity = opacity;
  stateRef.current.effect = effect;
  stateRef.current.autoPlay = autoPlay;
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
        const e = err instanceof Error ? err : new Error(String(err));
        onError?.(e);
        // Without a parsed mark there's nothing for StaticFallback to draw
        // either, so we just render an empty container.
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
    state.reducedMotion =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
    state.triggered = state.effect === 'none' || state.reducedMotion || state.autoPlay;
    state.effectStart = performance.now();
    state.visible = true;

    let cancelled = false;
    let renderer: Renderer | null = null;
    let ro: ResizeObserver | null = null;
    let io: IntersectionObserver | null = null;

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

    const computeFrame = (preset: Effect | null, pathCount: number): EffectFrame => {
      if (!preset) return { done: true };
      if (state.reducedMotion) return preset.at(preset.durationMs, pathCount);
      if (!state.triggered) return preset.initial(pathCount);
      const elapsed = performance.now() - state.effectStart;
      return elapsed >= preset.durationMs
        ? preset.at(preset.durationMs, pathCount)
        : preset.at(elapsed, pathCount);
    };

    const renderOnce = (): boolean => {
      const r = renderer;
      if (!r) return true;
      const preset = state.effect === 'none' ? null : EFFECTS[state.effect];
      const frame = computeFrame(preset, r.pathCount);
      const [cr, cg, cb] = parseColor(state.color);
      const offsets = frame.pathOffsets ?? zeroOffsets(r.pathCount);
      r.render({
        width: canvas.width,
        height: canvas.height,
        zoom: 1,
        sminK: frame.sminK ?? DEFAULT_SMIN_K,
        offsetX: 0,
        offsetY: 0,
        pathOffsets: offsets,
        color: [cr, cg, cb],
        opacity: (frame.opacity ?? 1) * state.opacity,
      });
      return frame.done;
    };

    const tick = () => {
      const done = renderOnce();
      if (done || !state.visible) {
        state.rafId = 0;
      } else {
        state.rafId = requestAnimationFrame(tick);
      }
    };

    const startLoop = () => {
      if (state.rafId !== 0) return;
      if (!state.visible && state.pauseWhenOffscreen) return;
      state.rafId = requestAnimationFrame(tick);
    };

    const trigger = () => {
      if (state.triggered) return;
      state.triggered = true;
      state.effectStart = performance.now();
      startLoop();
    };

    state.requestRender = () => {
      // A single frame at current state — used for prop changes (color,
      // opacity) that don't affect the animation timeline.
      renderOnce();
    };

    state.replay = () => {
      if (state.effect === 'none' || state.reducedMotion) return;
      if (state.rafId !== 0) cancelAnimationFrame(state.rafId);
      state.rafId = 0;
      state.triggered = true;
      state.effectStart = performance.now();
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
        const e = err instanceof Error ? err : new Error(String(err));
        onError?.(e);
        setFallback(true);
        return;
      }

      // First frame immediately — either the effect's initial/reduced state
      // or the static pose. Prevents the "empty flash" between renderer
      // init and the first rAF tick.
      renderOnce();

      ro = new ResizeObserver(() => {
        if (sizeCanvas()) renderOnce();
      });
      ro.observe(container);

      const needsScrollTrigger =
        state.effect !== 'none' && !state.autoPlay && !state.reducedMotion;

      if (needsScrollTrigger || state.pauseWhenOffscreen) {
        io = new IntersectionObserver(
          (entries) => {
            const entry = entries[entries.length - 1];
            if (!entry) return;
            const visible = entry.isIntersecting;
            state.visible = visible;
            if (visible) {
              if (needsScrollTrigger && !state.triggered) {
                trigger();
              } else if (state.triggered && state.effect !== 'none' && state.rafId === 0) {
                // Resume paused rAF if the animation hasn't finished yet.
                const preset = EFFECTS[state.effect];
                const elapsed = performance.now() - state.effectStart;
                if (elapsed < preset.durationMs) startLoop();
              }
            } else if (state.pauseWhenOffscreen && state.rafId !== 0) {
              cancelAnimationFrame(state.rafId);
              state.rafId = 0;
            }
          },
          { threshold: 0.01 },
        );
        io.observe(container);
      }

      // Autoplay path (no scroll trigger, no reduce-motion): start the loop
      // as soon as the renderer is ready.
      if (state.effect !== 'none' && !state.reducedMotion && state.autoPlay) {
        startLoop();
      }
    })();

    return () => {
      cancelled = true;
      if (state.rafId !== 0) cancelAnimationFrame(state.rafId);
      state.rafId = 0;
      state.requestRender = () => {};
      state.replay = () => {};
      ro?.disconnect();
      io?.disconnect();
      renderer?.dispose();
      renderer = null;
    };
  }, [mark, rendererKind, onReady, onError]);

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
