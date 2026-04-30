import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef, useEffect, type RefObject } from 'react';
import { useCanvasSize } from './useCanvasSize';

// Capture ResizeObserver callbacks so tests can fire them on demand.
let roCallbacks: ResizeObserverCallback[] = [];
let roDisconnects: number = 0;

class FakeResizeObserver implements ResizeObserver {
  constructor(cb: ResizeObserverCallback) { roCallbacks.push(cb); }
  observe() {}
  unobserve() {}
  disconnect() { roDisconnects += 1; }
}

// Capture matchMedia listeners so tests can fire DPR change events.
interface FakeMQL {
  matches: boolean;
  media: string;
  listeners: Set<(e: MediaQueryListEvent) => void>;
}
const mqls: FakeMQL[] = [];

const stubMatchMedia = () => {
  vi.stubGlobal('matchMedia', (media: string) => {
    const mql: FakeMQL = { matches: false, media, listeners: new Set() };
    mqls.push(mql);
    return {
      matches: false,
      media,
      addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => mql.listeners.add(l),
      removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => mql.listeners.delete(l),
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  });
};

const setRect = (el: Element, w: number, h: number) => {
  el.getBoundingClientRect = () =>
    ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
};

// Render a fixture div and a hook that observes it. Returns the hook's
// `result` plus the div so tests can mutate its bounding rect.
const renderWithDiv = (initialW: number, initialH: number) => {
  let div: HTMLDivElement | null = null;
  const { result, rerender, unmount } = renderHook(() => {
    const ref = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      if (ref.current) {
        div = ref.current;
        setRect(div, initialW, initialH);
      }
    }, []);
    // Need a div mounted to give the ref something to attach to.
    return { ref, size: useCanvasSize(ref as RefObject<Element | null>) };
  });
  return { result, rerender, unmount, getDiv: () => div };
};

describe('useCanvasSize', () => {
  beforeEach(() => {
    roCallbacks = [];
    roDisconnects = 0;
    mqls.length = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('devicePixelRatio', 1);
    stubMatchMedia();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns ZERO when ref is null at mount', () => {
    const nullRef = { current: null } as RefObject<Element | null>;
    const { result } = renderHook(() => useCanvasSize(nullRef));
    expect(result.current).toEqual({ cssWidth: 0, cssHeight: 0, dpr: 1 });
  });

  it('reads width/height from the element bounding rect on mount', () => {
    // We can't easily wire up a real ref through renderHook + useEffect-on-
    // first-render timing, so test the update path directly: start with a
    // null ref's ZERO state, then exercise a second render where the ref
    // resolves. The simpler approach is to construct the ref ourselves.
    const el = document.createElement('div');
    setRect(el, 320, 180);
    const ref = { current: el } as RefObject<Element>;
    const { result } = renderHook(() => useCanvasSize(ref));
    expect(result.current.cssWidth).toBe(320);
    expect(result.current.cssHeight).toBe(180);
    expect(result.current.dpr).toBe(1);
  });

  it('caps DPR at 2 even when devicePixelRatio is higher', () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const el = document.createElement('div');
    setRect(el, 100, 100);
    const ref = { current: el } as RefObject<Element>;
    const { result } = renderHook(() => useCanvasSize(ref));
    expect(result.current.dpr).toBe(2);
  });

  it('updates when the ResizeObserver callback fires', () => {
    const el = document.createElement('div');
    setRect(el, 100, 100);
    const ref = { current: el } as RefObject<Element>;
    const { result } = renderHook(() => useCanvasSize(ref));
    expect(result.current.cssWidth).toBe(100);

    setRect(el, 250, 75);
    act(() => {
      // Fire every captured RO callback (the hook registered exactly one).
      for (const cb of roCallbacks) cb([], {} as ResizeObserver);
    });
    expect(result.current.cssWidth).toBe(250);
    expect(result.current.cssHeight).toBe(75);
  });

  it('preserves referential identity when size has not changed', () => {
    const el = document.createElement('div');
    setRect(el, 100, 100);
    const ref = { current: el } as RefObject<Element>;
    const { result } = renderHook(() => useCanvasSize(ref));
    const first = result.current;
    act(() => {
      for (const cb of roCallbacks) cb([], {} as ResizeObserver);
    });
    expect(result.current).toBe(first);
  });

  it('disconnects the ResizeObserver on unmount', () => {
    const el = document.createElement('div');
    setRect(el, 100, 100);
    const ref = { current: el } as RefObject<Element>;
    const { unmount } = renderHook(() => useCanvasSize(ref));
    expect(roDisconnects).toBe(0);
    unmount();
    expect(roDisconnects).toBe(1);
  });

  it('re-reads DPR when the matchMedia listener fires', () => {
    const el = document.createElement('div');
    setRect(el, 100, 100);
    const ref = { current: el } as RefObject<Element>;
    const { result } = renderHook(() => useCanvasSize(ref));
    expect(result.current.dpr).toBe(1);

    vi.stubGlobal('devicePixelRatio', 2);
    act(() => {
      // Fire the most recently added MQL listener (the hook re-subscribes
      // each time DPR changes — fire whatever's currently active).
      const mql = mqls[mqls.length - 1]!;
      for (const l of mql.listeners) l({} as MediaQueryListEvent);
    });
    expect(result.current.dpr).toBe(2);
  });
});
