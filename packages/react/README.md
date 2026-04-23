# @bezier-sdf/react

A drop-in React component wrapping [`@bezier-sdf/core`](../core). Points it at an SVG URL and it handles the rest — fetch, parse, normalize, GPU renderer init, DPR, resize, WebGPU→WebGL→SVG fallback, optional intro animations, and cleanup on unmount.

```bash
pnpm add @bezier-sdf/react @bezier-sdf/core react react-dom
```

## Basics

```tsx
import { BezierLogo } from '@bezier-sdf/react';

<BezierLogo src="/logo.svg" color="#ff3a7a" />
```

Renders the SVG silhouette through a GPU signed-distance field inside the component's layout box. No animation by default.

## Intro animation

```tsx
<BezierLogo src="/logo.svg" color="#ff3a7a" effect="reveal" />
```

With `effect="reveal"` and the default `autoPlay={false}`, the animation waits for the component to scroll into view, then plays once. Pass `autoPlay` to play on mount:

```tsx
<BezierLogo src="/logo.svg" effect="reveal" autoPlay />
```

## Replay

```tsx
const ref = useRef<BezierLogoHandle>(null);
// …
<BezierLogo ref={ref} src="/logo.svg" effect="reveal" />
<button onClick={() => ref.current?.replay()}>replay</button>
```

## Props

| Prop | Type | Default | |
|---|---|---|---|
| `src` | `string` | — | SVG URL or data URI. |
| `color` | `string` | `'#000'` | Any CSS color. |
| `opacity` | `number` | `1` | 0..1 multiplier applied on top of any effect opacity. |
| `effect` | `'none' \| 'reveal'` | `'none'` | Intro effect preset. |
| `autoPlay` | `boolean` | `false` | Skip the scroll-into-view wait. |
| `renderer` | `'auto' \| 'webgpu' \| 'webgl'` | `'auto'` | Force a backend. |
| `pauseWhenOffscreen` | `boolean` | `true` | Cancel rAF while offscreen. |
| `onReady` | `(info: { kind: 'webgpu' \| 'webgl' }) => void` | — | Fires once the renderer is live. |
| `onError` | `(err: Error) => void` | — | Fires on fetch/parse errors or renderer init failure. |
| `ariaLabel` | `string` | — | Applied to the container; sets `role="img"`. |
| `className`, `style` | | — | Forwarded to the container div. |

## Reduced motion

When `window.matchMedia('(prefers-reduced-motion: reduce)').matches`, effects skip to their final frame — no animation plays. `replay()` is a no-op in this mode.

## Fallback

If both WebGPU and WebGL fail to initialize, `<BezierLogo>` renders the parsed SVG through `<StaticFallback>` (pure-SVG `<path>` trace) so users on unsupported hardware still see the mark.

## SVG requirements

- Your SVG must already be in `<path>` form. `<rect>`, `<circle>`, `<polygon>` are ignored — run your file through Inkscape's *Object to Path* (or equivalent) first.
- Elliptical arcs (`A`/`a` path commands) aren't supported — see [`@bezier-sdf/core`'s `parseSvgPath`](../core/README.md) for conversion tips.
- Up to 4 paths per SVG (renderer limit).

## SSR

This component is client-only. In Next.js:

```tsx
import dynamic from 'next/dynamic';
const BezierLogo = dynamic(
  () => import('@bezier-sdf/react').then((m) => m.BezierLogo),
  { ssr: false },
);
```

## License

MIT
