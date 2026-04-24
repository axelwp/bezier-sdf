# @bezier-sdf/react

A drop-in React component wrapping [`@bezier-sdf/core`](https://www.npmjs.com/package/@bezier-sdf/core). Point it at an SVG URL; the component fetches, parses, and normalizes the file, boots a GPU renderer (WebGPU with WebGL and static-SVG fallbacks), handles DPR and resize, respects `prefers-reduced-motion`, runs any interactive effects you configure, and cleans up on unmount.

```bash
npm install @bezier-sdf/react @bezier-sdf/core
```

## Quick start

```tsx
import { BezierLogo } from '@bezier-sdf/react';

export default function Logo() {
  return <BezierLogo src="/logo.svg" color="#ff3a7a" />;
}
```

Renders the SVG silhouette through a GPU signed-distance field inside the component's layout box. Give the container a width and height (or let your layout do it); the canvas tracks the container.

## Effects

`effect` accepts a single preset name, a single spec object, or an array to compose multiple effects at once.

| Name | Trigger | Notes |
|---|---|---|
| `'none'` *(default)* | none | Static render. |
| `'reveal'` | Scroll-into-view, or `autoPlay` | Split-and-merge intro animation. Plays once per mount; use the [imperative handle](#imperative-handle) to replay. |
| `'ripple'` | Pointer down on the canvas | Gaussian shockwave ring through the silhouette. Up to 4 concurrent rings. |
| `'liquid-cursor'` | Pointer over the canvas | Silhouette bulges toward the pointer. Stroked paths thicken and warp under the cursor ("wet paint" model). |
| `'liquid-glass'` | none | Legacy alias for `material='glass'`. Prefer the [`material`](#material) prop for glass, and use the spec object form to tune. |

```tsx
<BezierLogo src="/logo.svg" effect="reveal" />                 {/* scroll-triggered */}
<BezierLogo src="/logo.svg" effect="reveal" autoPlay />        {/* plays on mount */}
<BezierLogo src="/logo.svg" effect="ripple" color="#9af078" /> {/* click the canvas */}
<BezierLogo src="/logo.svg" effect="liquid-cursor" />          {/* hover (or tap) */}
```

### Spec-object form (tuning)

Pass an object instead of a string to override an effect's defaults:

```tsx
<BezierLogo
  src="/logo.svg"
  effect={{ name: 'reveal', duration: 2000, startOffset: 0.5 }}
/>
```

### Composing effects

Pass an array to layer multiple presets. The built-ins use disjoint uniforms (reveal → path offsets; liquid-cursor → cursor field; ripple → ring buffer), so they compose without stepping on each other. Mix names and specs freely:

```tsx
<BezierLogo
  src="/logo.svg"
  effect={['liquid-cursor', { name: 'ripple', speed: 3.5, amplitude: 0.1 }]}
/>
```

On desktop, hover bulges the silhouette toward the pointer and clicks fire a ripple through it. On touch (no hover), tapping engages both at once.

### Effect parameters

Every parameter is optional; defaults are listed below. Live-updates: changing a spec's param re-tunes the running effect without tearing down the renderer.

#### `reveal`

| Param | Type | Default | Description |
|---|---|---|---|
| `duration` | `number` | `1400` | Animation length in ms. |
| `startOffset` | `number` | `0.3` | Initial displacement magnitude of each path, in normalized SDF units. Higher = paths start further apart before merging. |
| `sminK` | `number` | `0.08` | Soft-union radius during the reveal. Higher = more rubber-band fusion between paths as they merge. |

#### `ripple`

| Param | Type | Default | Description |
|---|---|---|---|
| `speed` | `number` | `2.8` | Radial growth rate of the ring, in SDF units per second. |
| `amplitude` | `number` | `0.08` | Peak SDF deformation at the ring crest. |
| `decay` | `number` | `3.5` | Exponential fade rate. Higher = quicker decay (shorter ring lifetime). |
| `duration` | `number` | *unset* | Optional hard ceiling in seconds. When set, rings are culled no later than this. |

#### `liquid-cursor`

| Param | Type | Default | Description |
|---|---|---|---|
| `pull` | `number` | `0.08` | Peak SDF deformation at the cursor. Higher = more aggressive bulge. |
| `radius` | `number` | `0.15` | Gaussian sigma of the pull falloff. This is the spatial extent of the deformation. |
| `lerp` | `number` | `0.5` | Per-frame smoothing factor (0..1) between raw pointer and rendered cursor position. Lower = laggier, smoother trails. |

#### `liquid-glass`

See [Material: glass](#material).

## Material

The `material` prop switches the silhouette's sample pipeline to a dedicated shader. Currently one material is supported: `'glass'`.

```tsx
<BezierLogo src="/logo.svg" material="glass" backdrop="/hero.jpg" />
```

`material='glass'` composes with the frame-based effects. Combine it with `liquid-cursor` or `ripple` to get a glass lens that also deforms around the pointer:

```tsx
{/* A glass lens that ripples on click */}
<BezierLogo
  src="/logo.svg"
  material="glass"
  effect="ripple"
  backdrop="/hero.jpg"
/>

{/* A glass lens that bulges under the pointer */}
<BezierLogo
  src="/logo.svg"
  material="glass"
  effect="liquid-cursor"
  backdrop="/hero.jpg"
/>
```

### Liquid glass + ripple

The canonical composed effect. The glass lens refracts your backdrop; a pointerdown seeds a shockwave that propagates through the lens geometry, so the refraction itself distorts in sync with the ring. Pair it with a tuned ripple spec:

```tsx
<BezierLogo
  src="/logo.svg"
  material="glass"
  effect={[
    { name: 'ripple', speed: 3.2, amplitude: 0.09 },
    { name: 'liquid-glass', refractionStrength: 0.06, frostStrength: 3 },
  ]}
  backdrop="/hero.jpg"
/>
```

Glass-specific parameters travel alongside the composition via a `liquid-glass` spec object in the `effect` array; the `material` prop is what actually activates the pipeline. (The legacy `effect='liquid-glass'` form still works on its own and will auto-activate the material, but the `material` prop is the composable path.)

### Glass parameters

Pass any of these via a `{ name: 'liquid-glass', ...params }` spec in the `effect` array.

| Param | Type | Default | Description |
|---|---|---|---|
| `refractionStrength` | `number` | `0.05` | Peak inward displacement of the backdrop sample, in normalized SDF units. Higher = more aggressive bending. |
| `chromaticStrength` | `number` | `0.015` | Relative magnitude of the R/B offset vs G. Produces the rainbow fringe on curves. Scalar in roughly `[0, 0.1]`. |
| `fresnelStrength` | `number` | `0.3` | Additive intensity of the rim band along the shape's edge. |
| `tintStrength` | `number` | `0.1` | Mixing weight of `tintColor` across the interior, scaled by depth-in-shape. |
| `frostStrength` | `number` | `2.5` | Radius (in physical pixels) of the cross-blur applied across the interior for a frosted quality. `0` = perfectly clear, `2–4` = Apple-style liquid glass. |
| `rimColor` | `string` | `'#ffffff'` | Any CSS color. Applied to the fresnel rim. |
| `tintColor` | `string` | `'#e8f0ff'` | Any CSS color. Tints the interior lens. |

### The `backdrop` prop

Required whenever glass is active. Accepts a URL (fetched with `crossOrigin='anonymous'`) or a ready `HTMLImageElement` / `HTMLCanvasElement` / `ImageBitmap`. The renderer uploads it once at init; changing the value triggers a renderer re-init.

Aspect: the image is center-cropped (CSS `cover`) to the canvas aspect before being sampled. If you paint the same image behind the canvas (e.g. `background-size: cover; background-position: center`), the in-lens content lines up with the scene behind it.

### The `backdropBlur` prop

Gaussian blur (in CSS pixels of the display canvas) applied to the backdrop *after* it's been resized to match the canvas's backing store. Default `6`. Set to `0` for crisp refraction (best for gradients, grids, UI screenshots); raise to `10–16` for heavy frosting over photos. Re-applied on resize so the kernel radius stays correct in display space.

Why blur? Refraction sampling reads a different pixel per destination fragment. On a high-frequency backdrop (photos, textures) those neighboring lookups land on unrelated detail and refraction reads as noise. Pre-blurring attenuates that and produces smooth warping.

### Stroked SVGs under glass

Stroked paths render as illuminated glass filaments rather than refracting lenses. A 2–4px sausage doesn't have enough interior area for the full glass effect to read as lens-like. Both aesthetics are valid: filled SVGs give you lens refraction, stroked SVGs give you glass-tube lighting.

## Imperative handle

Forward a ref to `BezierLogo` to replay animations on demand:

```tsx
import { useRef } from 'react';
import { BezierLogo, type BezierLogoHandle } from '@bezier-sdf/react';

function ReplayableLogo() {
  const ref = useRef<BezierLogoHandle>(null);
  return (
    <>
      <BezierLogo ref={ref} src="/logo.svg" effect="reveal" />
      <button onClick={() => ref.current?.replay()}>Replay</button>
    </>
  );
}
```

`replay()` resets time-based effects (reveal re-plays) and clears reactive buffers. It's a no-op under `prefers-reduced-motion: reduce`.

## Props reference

| Prop | Type | Default | Description |
|---|---|---|---|
| `src` | `string` | *required* | SVG URL or data URI. Fetched once and cached per-src across component instances. |
| `color` | `string` | *none* | Optional global color override. When set, every path is painted with this color (legacy smin mode). Omit to honor the SVG's per-path fill/stroke. Ignored when `material='glass'`. |
| `opacity` | `number` | `1` | 0..1 multiplier applied on top of any per-effect opacity. |
| `effect` | `BezierLogoEffectProp` | `'none'` | Single preset name, spec object, or array of either. See [Effects](#effects). |
| `autoPlay` | `boolean` | `false` | For `reveal`: skip the scroll-into-view wait and play on mount. Ignored by reactive effects. |
| `material` | `'glass'` | *none* | Switch the silhouette pipeline to a material shader. Composes with frame-based effects. See [Material](#material). |
| `backdrop` | `string \| HTMLImageElement \| HTMLCanvasElement \| ImageBitmap` | *none* | Image to refract when glass is active. Required whenever glass is active. |
| `backdropBlur` | `number` | `6` | Pre-blur radius (display-space pixels) applied to the backdrop. `0` disables. |
| `renderer` | `'auto' \| 'webgpu' \| 'webgl'` | `'auto'` | Force a specific backend. `'auto'` cascades WebGPU to WebGL to static SVG. |
| `pauseWhenOffscreen` | `boolean` | `true` | Cancel rAF while the element is outside the viewport. |
| `onReady` | `(info: { kind: 'webgpu' \| 'webgl' }) => void` | *none* | Fires once the GPU renderer is live. |
| `onError` | `(error: Error) => void` | *none* | Fires on fetch/parse errors, missing-backdrop errors, or both-backends-failed. The component falls back to static SVG automatically. |
| `ariaLabel` | `string` | *none* | Applied to the container; sets `role="img"`. |
| `className` | `string` | *none* | Forwarded to the container `<div>`. |
| `style` | `CSSProperties` | *none* | Forwarded to the container `<div>`. `position: 'relative'` is added automatically. |

## Reduced motion

When `window.matchMedia('(prefers-reduced-motion: reduce)').matches`, effects skip to their settled state. No animation plays and `replay()` becomes a no-op. Reactive effects (`ripple`, `liquid-cursor`) don't fire at all; the silhouette renders statically.

## Fallback

If both WebGPU and WebGL fail to initialize, `<BezierLogo>` renders the parsed SVG through `<StaticFallback>` (pure-SVG `<path>` trace) so users on unsupported hardware still see the mark. `onError` fires with the renderer error in this case, but nothing is thrown.

You can also import `StaticFallback` directly if you want to render the static form without attempting GPU init:

```tsx
import { StaticFallback } from '@bezier-sdf/react';
```

## SVG support

Works with most real-world SVGs:

- Filled paths, stroked paths, and mixed fill + stroke.
- Multiple subpaths per `<path>` element (ring shapes, icons with holes, grouped icons).
- Per-path fill and stroke colors preserved.
- Up to 16 paths per SVG.

Known caveats:

- **Path geometry only.** `<rect>`, `<circle>`, `<polygon>` shapes are ignored. Run your file through Inkscape's *Object to Path* first.
- **No elliptical arcs.** `A`/`a` commands aren't supported. Flatten arcs to cubics via `svgo` (`convertPathData`) or Inkscape's path simplification.
- **No gradients, masks, patterns, or filters.** Solid fills and strokes only.

## SSR

`<BezierLogo>` is client-only (it touches `window`, `document`, and GPU APIs on mount). In Next.js, wrap the import:

```tsx
import dynamic from 'next/dynamic';

const BezierLogo = dynamic(
  () => import('@bezier-sdf/react').then((m) => m.BezierLogo),
  { ssr: false },
);
```

In Remix, Astro, and other SSR frameworks, render the component inside a client-island or client-only boundary.

## Additional exports

```ts
import {
  BezierLogo,
  StaticFallback,
  clearSvgCache,
  type BezierLogoProps,
  type BezierLogoHandle,
  type BezierLogoEffect,
  type BezierLogoEffectName,
  type BezierLogoEffectProp,
  type BezierLogoEffectSpec,
  type BezierLogoBackdrop,
  type RevealParams,
  type RippleParams,
  type LiquidCursorParams,
  type LiquidGlassParams,
  type StaticFallbackProps,
} from '@bezier-sdf/react';
```

`clearSvgCache()` evicts every memoized `src → Mark` entry. Useful in tests or after hot-swapping build output at the same URL during development.

## Peer dependencies

| Package | Version |
|---|---|
| `react` | `>=18` |
| `react-dom` | `>=18` |
| `@bezier-sdf/core` | `workspace` (installed alongside) |

## License

MIT. See [LICENSE](./LICENSE).
