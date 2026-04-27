# @bezier-sdf/react

[![npm version](https://img.shields.io/npm/v/@bezier-sdf/react.svg)](https://www.npmjs.com/package/@bezier-sdf/react)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@bezier-sdf/react.svg)](https://bundlephobia.com/package/@bezier-sdf/react)
[![license](https://img.shields.io/npm/l/@bezier-sdf/react.svg)](./LICENSE)

A drop-in React component wrapping [`@bezier-sdf/core`](https://www.npmjs.com/package/@bezier-sdf/core). Point it at an SVG URL; the component fetches, parses, and normalizes the file, boots a GPU renderer (WebGPU with WebGL and static-SVG fallbacks), handles DPR and resize, respects `prefers-reduced-motion`, runs any interactive effects you configure, and cleans up on unmount.

> Pre-1.0. The public API may shift between minor versions until 1.0.

## Install

```bash
npm install @bezier-sdf/react @bezier-sdf/core
```

Peer-deps on React 18+ and ReactDOM 18+. ESM only.

## Quick start

```tsx
import { LiveGraphic } from '@bezier-sdf/react';

export default function Logo() {
  return <LiveGraphic src="/logo.svg" color="#ff3a7a" />;
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
| `'morph'` | Pointer over the canvas | Hover-driven shape-to-shape morph between `src` and `to`. Both shapes bake into a unified silhouette SDF and lerp; each source path keeps its own SVG fill/stroke color through the transition by default, or pair with [`color`](#props-reference) / [`toFillColor`](#props-reference) to flatten a side to a single color. Works with mixed fill/stroke SVGs (stroked subpaths bake as sausage SDFs and union cleanly with filled paths). Composes with `material='glass'` for refraction through a morphing silhouette. See [Morph](#morph-1). |
| `'liquid-glass'` | none | Legacy alias for `material='glass'`. Prefer the [`material`](#material) prop for glass, and use the spec object form to tune. |

```tsx
<LiveGraphic src="/logo.svg" effect="reveal" />                 {/* scroll-triggered */}
<LiveGraphic src="/logo.svg" effect="reveal" autoPlay />        {/* plays on mount */}
<LiveGraphic src="/logo.svg" effect="ripple" color="#9af078" /> {/* click the canvas */}
<LiveGraphic src="/logo.svg" effect="liquid-cursor" />          {/* hover (or tap) */}
```

### Spec-object form (tuning)

Pass an object instead of a string to override an effect's defaults:

```tsx
<LiveGraphic
  src="/logo.svg"
  effect={{ name: 'reveal', duration: 2000, startOffset: 0.5 }}
/>
```

### Composing effects

Pass an array to layer multiple presets. The built-ins use disjoint uniforms (reveal → path offsets; liquid-cursor → cursor field; ripple → ring buffer), so they compose without stepping on each other. Mix names and specs freely:

```tsx
<LiveGraphic
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

#### `morph`

| Param | Type | Default | Description |
|---|---|---|---|
| `rate` | `number` | `15` | Exponential approach rate (units `1/s`). Smoothed `t` follows the hover target via `t += (target - t) * (1 - exp(-rate*dt))`. Default reaches ~95% in ~200 ms (snappy but not jarring). Lower for more languid morphs. |

See [Morph](#morph-1) for usage and the related `to` / `toFillColor` / `fillRule` props.

#### `liquid-glass`

See [Material: glass](#material).

## Material

The `material` prop switches the silhouette's sample pipeline to a dedicated shader. Currently one material is supported: `'glass'`.

```tsx
<LiveGraphic src="/logo.svg" material="glass" backdrop="/hero.jpg" />
```

`material='glass'` composes with the frame-based effects. Combine it with `liquid-cursor` or `ripple` to get a glass lens that also deforms around the pointer:

```tsx
{/* A glass lens that ripples on click */}
<LiveGraphic
  src="/logo.svg"
  material="glass"
  effect="ripple"
  backdrop="/hero.jpg"
/>

{/* A glass lens that bulges under the pointer */}
<LiveGraphic
  src="/logo.svg"
  material="glass"
  effect="liquid-cursor"
  backdrop="/hero.jpg"
/>

{/* A glass lens that morphs into a different shape on hover */}
<LiveGraphic
  src="/logo.svg"
  to="/logo-alt.svg"
  material="glass"
  backdrop="/hero.jpg"
/>
```

### Liquid glass + ripple

The canonical composed effect. The glass lens refracts your backdrop; a pointerdown seeds a shockwave that propagates through the lens geometry, so the refraction itself distorts in sync with the ring. Pair it with a tuned ripple spec:

```tsx
<LiveGraphic
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

### Liquid glass + morph

Add a `to` prop alongside glass for refraction through a continuously morphing silhouette. Both shapes are baked as combined SDFs at init; the glass shader blends them per fragment by the morph's hover-driven `t`, so the surface normals follow the deforming geometry, the rim Fresnel band tracks the silhouette as it changes, and the chromatic fringe rides along the moving curvature.

```tsx
<LiveGraphic
  src="/icons/circle.svg"
  to="/icons/star.svg"
  material="glass"
  backdrop="/hero.jpg"
/>
```

Setting `to` is enough to engage the morph runtime; you don't have to add `'morph'` to `effect`. Tune the morph rate via a spec if needed:

```tsx
<LiveGraphic
  src="/icons/circle.svg"
  to="/icons/star.svg"
  material="glass"
  effect={[
    { name: 'morph', rate: 8 },
    { name: 'liquid-glass', refractionStrength: 0.06 },
  ]}
  backdrop="/hero.jpg"
/>
```

Stack `ripple` or `liquid-cursor` into the array to add pointer interaction on top of the glass morph. Reduced motion freezes `t = 0` (shape A) and skips the rAF loop.

### Glass parameters

Pass any of these via a `{ name: 'liquid-glass', ...params }` spec in the `effect` array.

| Param | Type | Default | Description |
|---|---|---|---|
| `refractionStrength` | `number` | `0.05` | Peak inward displacement of the backdrop sample, in normalized SDF units. Higher = more aggressive bending. |
| `chromaticStrength` | `number` | `0.015` | Relative magnitude of the R/B offset vs G. Produces the rainbow fringe on curves. Scalar in roughly `[0, 0.1]`. |
| `fresnelStrength` | `number` | `0.3` | Additive intensity of the rim band along the shape's edge. |
| `tintStrength` | `number` | `0.1` | Mixing weight of `tintColor` across the interior, scaled by depth-in-shape. |
| `frostStrength` | `number` | `2.5` | Radius (in physical pixels) of the cross-blur applied across the interior for a frosted quality. `0` = perfectly clear, `2` to `4` = Apple-style liquid glass. |
| `rimColor` | `string` | `'#ffffff'` | Any CSS color. Applied to the fresnel rim. |
| `tintColor` | `string` | `'#e8f0ff'` | Any CSS color. Tints the interior lens. |

### The `backdrop` prop

Required whenever glass is active. Accepts a URL (fetched with `crossOrigin='anonymous'`) or a ready `HTMLImageElement` / `HTMLCanvasElement` / `ImageBitmap`. The renderer uploads it once at init; changing the value triggers a renderer re-init.

Aspect: the image is center-cropped (CSS `cover`) to the canvas aspect before being sampled. If you paint the same image behind the canvas (e.g. `background-size: cover; background-position: center`), the in-lens content lines up with the scene behind it.

### The `backdropBlur` prop

Gaussian blur (in CSS pixels of the display canvas) applied to the backdrop *after* it's been resized to match the canvas's backing store. Default `6`. Set to `0` for crisp refraction (best for gradients, grids, UI screenshots); raise to `10` or `16` for heavy frosting over photos. Re-applied on resize so the kernel radius stays correct in display space.

Why blur? Refraction sampling reads a different pixel per destination fragment. On a high-frequency backdrop (photos, textures) those neighboring lookups land on unrelated detail and refraction reads as noise. Pre-blurring attenuates that and produces smooth warping.

### Stroked SVGs under glass

Stroked paths render as illuminated glass filaments rather than refracting lenses. A 2 to 4px sausage doesn't have enough interior area for the full glass effect to read as lens-like. Both aesthetics are valid: filled SVGs give you lens refraction, stroked SVGs give you glass-tube lighting.

## Morph

Hover-driven interpolation between two SVGs. The component loads both `src` and `to`, bakes each into a single combined SDF (one texture per side), and the morph shader linearly interpolates the two distance fields per pixel. You get one unified silhouette that flows from shape A to shape B as the pointer enters the canvas, and back out as it leaves.

```tsx
<LiveGraphic
  src="/icons/circle.svg"
  to="/icons/star.svg"
/>
```

That's enough to engage the morph runtime, and each path on either side keeps its own SVG fill/stroke color through the transition. Add `color` and/or `toFillColor` if you want to flatten a side to a single tint:

```tsx
<LiveGraphic
  src="/icons/circle.svg"
  to="/icons/star.svg"
  color="#22d3ee"
  toFillColor="#f472b6"
/>
```

Setting the `to` prop alone is enough to engage the morph runtime; the explicit `effect="morph"` is only needed if you want to tune `rate` via the spec form. The runtime is also auto-included whenever `to` is paired with `material="glass"` (see [Liquid glass + morph](#liquid-glass--morph) for refraction through the morphing silhouette).

Behavioral details:

- **Per-path colors are preserved by default.** The bake records, alongside the SDF, which source path owns each pixel. The morph shader uses that lookup to paint each region with its intrinsic SVG fill or stroke color on side A, the corresponding color on side B, and lerps between them as `t` advances. `color` flattens side A to a single color (the start of the morph); `toFillColor` flattens side B (the end). Mixed mode works (override one side, leave the other per-path). Omitting both gives you the full per-path A→B color morph.
- **Mixed fill + stroke is supported.** Stroked subpaths inside either shape bake as sausage SDFs (`|d| − strokeWidth/2`) and union with filled paths cleanly. Open subpaths in stroked SVGs (e.g. eyebrows or a mouth line in a smiley icon) no longer leak parity-garbage wisps into the silhouette.
- **Reduced motion.** Stays at `t = 0` (shape A) and skips the rAF loop entirely.
- **Fill rule.** The bake uses [`fillRule`](#props-reference) (default `'nonzero'`) to decide how each path's interior is determined. The default avoids cross-path fill artifacts in multi-path icons; switch to `'evenodd'` only when the source artwork relies on global subtractive parity (rare).

### Morph parameters

See the [`morph`](#morph) effect parameter table above for the `rate` knob. Pass it via the spec form:

```tsx
<LiveGraphic
  src="/a.svg"
  to="/b.svg"
  effect={{ name: 'morph', rate: 8 }}
/>
```

### Limits

- Up to 16 paths per side. Beyond that, trailing paths are merged into the last allowed slot (warned via `console.warn`).
- Per-side combined segment count must fit the renderer's bake-shader cap (1024 cubics on both backends). Throws at init time with a clear message if exceeded; flatten arcs or simplify paths in your source SVG.

## Imperative handle

Forward a ref to `LiveGraphic` to replay animations on demand:

```tsx
import { useRef } from 'react';
import { LiveGraphic, type LiveGraphicHandle } from '@bezier-sdf/react';

function ReplayableLogo() {
  const ref = useRef<LiveGraphicHandle>(null);
  return (
    <>
      <LiveGraphic ref={ref} src="/logo.svg" effect="reveal" />
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
| `color` | `string` | *none* | Optional global color override. When set, every path is painted with this color (legacy smin mode); in morph mode it flattens side A (the start of the morph) to this single color. Omit to honor the SVG's per-path fill/stroke. Ignored when `material='glass'` (except in glass+morph, where it overrides side A's interior tint the same way). |
| `opacity` | `number` | `1` | 0..1 multiplier applied on top of any per-effect opacity. |
| `effect` | `LiveGraphicEffectProp` | `'none'` | Single preset name, spec object, or array of either. See [Effects](#effects). |
| `to` | `string` | *none* | Target SVG URL for the morph pipeline. Setting `to` engages a hover-driven morph between `src` and the target without requiring an explicit `effect="morph"`. Pairs with `material="glass"` so the backdrop refracts through the morphing silhouette. |
| `toFillColor` | `string` | *none* | Flat color for the end of the morph (side B at `t=1`). When omitted, side B keeps each path's own SVG fill/stroke color and the morph lerps to those per-path colors. Pair with `color` to flatten side A as well. |
| `fillRule` | `'nonzero' \| 'evenodd'` | `'nonzero'` | Morph bake fill rule. Default is SVG's default and avoids cross-path fill artifacts in multi-path icons. Switch to `'evenodd'` only when the source artwork relies on cross-path subtractive even-odd semantics (a "donut" SVG drawn as outer + inner contour subtracted via global parity). Other shapes lose their inner subtraction in `'evenodd'` so prefer the default. |
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

If both WebGPU and WebGL fail to initialize, `<LiveGraphic>` renders the parsed SVG through `<StaticFallback>` (pure-SVG `<path>` trace) so users on unsupported hardware still see the mark. `onError` fires with the renderer error in this case, but nothing is thrown.

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

`<LiveGraphic>` is client-only (it touches `window`, `document`, and GPU APIs on mount). In Next.js, wrap the import:

```tsx
import dynamic from 'next/dynamic';

const LiveGraphic = dynamic(
  () => import('@bezier-sdf/react').then((m) => m.LiveGraphic),
  { ssr: false },
);
```

In Remix, Astro, and other SSR frameworks, render the component inside a client-island or client-only boundary.

## Additional exports

```ts
import {
  LiveGraphic,
  StaticFallback,
  clearSvgCache,
  type LiveGraphicProps,
  type LiveGraphicHandle,
  type LiveGraphicEffect,
  type LiveGraphicEffectName,
  type LiveGraphicEffectProp,
  type LiveGraphicEffectSpec,
  type LiveGraphicBackdrop,
  type RevealParams,
  type RippleParams,
  type LiquidCursorParams,
  type LiquidGlassParams,
  type MorphParams,
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
