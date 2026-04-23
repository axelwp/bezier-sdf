import { useEffect, useState, type RefObject } from 'react';

export interface CanvasSize {
  /** CSS pixel width of the container. */
  cssWidth: number;
  /** CSS pixel height of the container. */
  cssHeight: number;
  /** Effective device pixel ratio, capped at 2. */
  dpr: number;
}

const ZERO: CanvasSize = { cssWidth: 0, cssHeight: 0, dpr: 1 };

/**
 * Observe a container element's CSS size and current DPR. Caps DPR at 2
 * deliberately — the fragment shader cost scales with pixel count and the
 * quality gain above 2× is imperceptible for a vector silhouette.
 *
 * Re-fires on DPR changes (monitor hop, browser zoom on engines that don't
 * fire 'resize') by re-subscribing a `(resolution: Ndppx)` media query each
 * time it triggers.
 */
export function useCanvasSize(ref: RefObject<Element | null>): CanvasSize {
  const [size, setSize] = useState<CanvasSize>(ZERO);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const read = (): CanvasSize => {
      const rect = el.getBoundingClientRect();
      return {
        cssWidth: rect.width,
        cssHeight: rect.height,
        dpr: Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2),
      };
    };

    const update = () => {
      setSize((prev) => {
        const next = read();
        if (prev.cssWidth === next.cssWidth && prev.cssHeight === next.cssHeight && prev.dpr === next.dpr) {
          return prev;
        }
        return next;
      });
    };

    update();

    const ro = new ResizeObserver(update);
    ro.observe(el);

    let mql: MediaQueryList | null = null;
    const onDpr = () => {
      update();
      mql?.removeEventListener('change', onDpr);
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener('change', onDpr);
    };
    if (typeof window !== 'undefined' && window.matchMedia) {
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener('change', onDpr);
    }

    return () => {
      ro.disconnect();
      mql?.removeEventListener('change', onDpr);
    };
  }, [ref]);

  return size;
}
