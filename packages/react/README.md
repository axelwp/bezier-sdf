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

## Effects

| Value | Behavior |
|---|---|
| `'none'` (default) | Static render. |
| `'reveal'` | Split-and-merge intro. Waits for scroll-into-view unless `autoPlay`. |
| `'ripple'` | Click/tap the canvas → Gaussian shockwave ring through the silhouette. Up to 4 concurrent rings. |
| `'liquid-cursor'` | Hover the canvas → the silhouette bulges toward the pointer and fuses with it when close. |

```tsx
<BezierLogo src="/logo.svg" effect="reveal" />                 // scroll-triggered
<BezierLogo src="/logo.svg" effect="reveal" autoPlay />        // plays on mount
<BezierLogo src="/logo.svg" effect="ripple" color="#9af078" /> // click anywhere on the canvas
<BezierLogo src="/logo.svg" effect="liquid-cursor" />          // hover
```

### Composing effects

Pass an array to layer multiple presets. The built-ins use disjoint uniforms (reveal → `pathOffsets`; liquid-cursor → `cursor*`; ripple → `ripples`) so they compose without stepping on each other.

```tsx
<BezierLogo src="/logo.svg" effect={['liquid-cursor', 'ripple']} />
```

On desktop, hover bulges the silhouette toward the pointer and clicks fire a ripple through it. On touch (no hover), tapping engages both at once.

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
| `effect` | `'none' \| 'reveal' \| 'ripple' \| 'liquid-cursor' \| Array<…>` | `'none'` | Single preset or an array to compose. |
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
