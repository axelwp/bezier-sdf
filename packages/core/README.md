# @bezier-sdf/core

[![npm version](https://img.shields.io/npm/v/@bezier-sdf/core.svg)](https://www.npmjs.com/package/@bezier-sdf/core)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@bezier-sdf/core.svg)](https://bundlephobia.com/package/@bezier-sdf/core)
[![license](https://img.shields.io/npm/l/@bezier-sdf/core.svg)](./LICENSE)

Framework-agnostic GPU signed-distance-field rendering of cubic Bezier curves. Trace a logo in Inkscape or Figma, feed the path into `parseSvgPath`, and render it as a crisp anti-aliased silhouette on WebGPU or WebGL.

> Pre-1.0. The public API may shift between minor versions until 1.0.

## Install

```bash
npm install @bezier-sdf/core
```

ESM only. The package ships `import`-only entry points and assumes a browser or browser-like runtime with either WebGPU or WebGL 1 available.

## Quick start

```ts
import { createRenderer, DEMO_MARK } from '@bezier-sdf/core';

const canvas = document.querySelector<HTMLCanvasElement>('canvas#logo')!;
canvas.width = 800;
canvas.height = 800;

const { renderer, actualKind } = await createRenderer('auto', {
  canvas,
  mark: DEMO_MARK,
});

renderer.render({
  width: canvas.width,
  height: canvas.height,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  sminK: 0.08,
  pathOffsets: [[0, 0], [0, 0]], // one offset per path in the mark
  color: [1, 0.23, 0.48],
  opacity: 1,
});

console.log('rendered with', actualKind); // 'webgpu' or 'webgl'
```

## Your own logo

Trace your logo in Inkscape (`Path → Simplify` keeps segment count low) and export as Plain SVG. There are two ways to bring it in:

**Single path, single color.** Grab the `d` attribute and use `parseSvgPath`:

```ts
import { createRenderer, parseSvgPath, normalizeMark } from '@bezier-sdf/core';

const source = parseSvgPath('M 10 10 C 20 20, 40 20, 50 10 Z ...');
const { mark } = normalizeMark(source); // center + scale to fit the bake region

const { renderer } = await createRenderer('auto', { canvas, mark });
```

**Full SVG document, per-path paint metadata.** Use `parseSvgDocument` to keep each `<path>`'s fill, stroke, stroke width, and opacities. It resolves SVG paint inheritance (attributes on ancestor `<g>`, inline `style`, `currentColor`) the same way a browser would:

```ts
import { createRenderer, parseSvgDocument, normalizeMark } from '@bezier-sdf/core';

const svgText = await fetch('/icon.svg').then((r) => r.text());
const parsed = parseSvgDocument(svgText, { currentColor: [0, 0, 0] });
const { mark } = normalizeMark(parsed);

const { renderer } = await createRenderer('auto', { canvas, mark });
```

The `mark.paths` array is what the renderer animates. Give each path its own entry in `pathOffsets` and translate them independently to get the split-morph intro effect (see [the repo's reveal example](https://github.com/axelwp/bezier-sdf/tree/main/examples/reveal)).

## What it does

Most browser vector libraries (SVG, Canvas, Pixi, Lottie) compute vector shapes on the CPU and upload triangulated results to the GPU. That works for static scenes but scales poorly for animation: every frame where the shape changes needs a re-tessellation, a re-upload, and a re-rasterization.

`@bezier-sdf/core` skips that pipeline. The shape's cubic Bezier curves are the direct input to a GPU shader, which:

1. **Bakes** each path's signed-distance field into a half-float texture once at init. This is the expensive step. It evaluates "distance from this pixel to the nearest point on any Bezier in this path" for a 1024×1024 grid. Takes roughly one frame.
2. **Samples** those textures every frame at animation-translated UVs and smooth-unions the results. This is the cheap step. Per-pixel cost collapses from roughly 800 ops to two texture reads plus a polynomial smooth-min.

You get smooth animation of complex vector shapes without re-tessellation, and perfect anti-aliasing at any zoom (the shape is a distance field, not a triangle mesh, so `fwidth`-based AA gives sub-pixel edges for free).

### Mark-to-mark morph

For shape-to-shape interpolation, the renderer offers a separate **flatten-then-bake** pipeline. Both marks have all of their paths concatenated and baked into a single combined SDF per side; the morph fragment shader samples both textures and lerps `mix(dA, dB, t)` per pixel. The output is a single unified silhouette that flows from shape A to shape B as `t` advances from 0 to 1.

Alongside each side's SDF, the bake also writes a **path-index map**: a low-cost lookup texture that tags each pixel with the source path it belongs to. The render shader uses it to look up the matching color from a small per-side palette and then lerps A→B by `t`, so each region of the silhouette keeps its intrinsic SVG color through the transition instead of collapsing to a single tint. Glass+morph reuses the same lookup for the interior tint when no flat override is supplied. Pass these palettes per frame as `pathColorsA` / `pathColorsB` (one RGB triplet per path on each side, capped at `MORPH_MAX_PATHS`); omit a side's array to fall back to flat `colorA` / `colorB` for that side. Mixed mode is fine (override one side, per-path the other).

The bake distinguishes fill paths from stroke paths internally: filled subpaths use per-path even-odd parity; stroked subpaths bake as sausage SDFs (`pathMinD − strokeWidth/2`). Both produce proper signed fill SDFs that union via `min()` into a coherent silhouette, so SVGs that mix fills and strokes (icons with a circle plus stroked accents, line-art with closed and open subpaths, etc.) morph correctly without parity garbage from the open subpaths leaking into the result.

Each side is capped at `MORPH_MAX_PATHS` (16). If your input has more paths, run it through `prepareMorphPair` first to merge the trailing ones into the last allowed path. Activate the pipeline by passing `morphTo` (and optionally `morphFillRule`) to `createRenderer`, then per-frame uniforms include `morph: { t, colorA, colorB }`:

```ts
import { createRenderer, prepareMorphPair } from '@bezier-sdf/core';

const { markA, markB } = prepareMorphPair(shapeA, shapeB);
const { renderer } = await createRenderer('auto', {
  canvas,
  mark: markA,
  morphTo: markB,
  morphFillRule: 'nonzero',
});

renderer.render({
  width, height, zoom: 1, offsetX: 0, offsetY: 0, sminK: 0.08,
  pathOffsets: [], color: [0, 0, 0], opacity: 1,
  morph: { t: 0.5, colorA: [1, 0, 0], colorB: [0, 0, 1] },
});
```

To preserve each path's own color through the morph instead of using flat side tints, pass per-path palettes:

```ts
renderer.render({
  width, height, zoom: 1, offsetX: 0, offsetY: 0, sminK: 0.08,
  pathOffsets: [], color: [0, 0, 0], opacity: 1,
  morph: {
    t: 0.5,
    colorA: [0, 0, 0], // unused when pathColorsA is provided
    colorB: [0, 0, 0],
    pathColorsA: markA.paths.map((p) => p.fillColor),
    pathColorsB: markB.paths.map((p) => p.fillColor),
  },
});
```

See [`docs/technique.md`](https://github.com/axelwp/bezier-sdf/blob/main/docs/technique.md) for the full writeup.

### Liquid-glass mode

Pass an image as `backdrop` at init time and the renderer compiles a refractive material pipeline alongside the normal one. Per frame, set `glass: true` and the silhouette renders as a frosted lens that refracts and tints the backdrop, with optional chromatic aberration, Fresnel rim, and box blur. Glass is a material, not a painter: per-path colors and animation offsets are ignored when `glass` is on. Backdrop sources must be same-origin or served with appropriate CORS headers.

Glass also composes with the morph pipeline. Pass both `backdrop` and `morphTo` at init, then set `glass: true` together with `morph: { t, ... }` per frame; the lens SDF becomes a per-fragment lerp between the two morph-baked SDFs (dynamic-SDF mode), so refraction happens through a silhouette that smoothly morphs as `t` advances. Surface normals follow the deforming geometry, the rim Fresnel band tracks the changing edge, and the chromatic fringe rides along the moving curvature. The per-pixel cost adds one texture sample over plain glass. Colors inside the `morph` payload are unused in this mode (glass is still a material).

## API

### Geometry

```ts
import {
  parseSvgPath,       // SVG <path d="..."> → Mark
  parseSvgDocument,   // Full <svg>...</svg> document → Mark with per-path paint
  normalizeMark,      // center + scale to fit the bake region
  sampleBezierPath,   // N points along a path (for polyline tweens)
  evalCubic,          // single-segment evaluation at t
  subdivideMark,      // adaptive subdivision (cap segment chord length)
  prepareMorphPair,   // cap-merge two marks for the morph pipeline
  MORPH_MAX_PATHS,    // hard cap on paths per side in morph mode (16)
  DEMO_MARK,          // built-in demo: two rounded chevrons
  makePath, mark,     // small constructors with sensible defaults
} from '@bezier-sdf/core/geometry';
```

### Renderers

```ts
import {
  createRenderer,   // factory with WebGPU → WebGL fallback
  WebGPURenderer,   // direct access if you want to skip the factory
  WebGLRenderer,
  MAX_PATHS,        // hard cap on paths per mark in non-morph modes (16)
} from '@bezier-sdf/core/renderers';
```

Every renderer implements the same interface:

```ts
interface Renderer {
  kind: 'webgpu' | 'webgl';
  mode: 'baked' | 'direct';   // WebGL falls back to direct if half-float is missing
  pathCount: number;
  init(opts: RendererInitOptions): Promise<void>;
  render(uniforms: Uniforms): void;
  rebake(mark: Mark): void;          // re-run bake with new geometry; structural shape must match init
  setBackdrop(source: TexImageSource): void;  // hot-swap glass backdrop on resize/dpi change
  dispose(): void;
}
```

You normally do not call `init` yourself. `createRenderer` instantiates the chosen backend and awaits `init` for you.

#### `RendererInitOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `canvas` | `HTMLCanvasElement` | *required* | Target canvas. The renderer takes ownership of its GPU context. |
| `mark` | `Mark` | *required* | Geometry. For morph, this is shape A. |
| `backdrop` | `TexImageSource` | *none* | Image to refract through the silhouette in liquid-glass mode. When omitted, the glass pipeline is not compiled and `Uniforms.glass` is ignored. |
| `morphTo` | `Mark` | *none* | When set, switches the renderer into morph mode. Both `mark` and `morphTo` are flattened into a single SDF per side. With no `backdrop`, the dedicated morph pipeline renders straight color-to-color silhouettes. With a `backdrop`, the glass pipeline is compiled instead and samples the two morph SDFs in dynamic mode, refracting the backdrop through a continuously morphing silhouette. The per-path sample and direct pipelines are skipped in either case. |
| `morphFillRule` | `'nonzero' \| 'evenodd'` | `'nonzero'` | Bake fill rule for both morph sides. `'nonzero'` (default) computes even-odd parity per path and unions paths via `min()`, which preserves intentional holes in a single path (the inside of an "O"). `'evenodd'` uses a single global crossing count across every segment; opt in only when the source artwork relies on cross-path subtractive parity. |

#### `Uniforms` highlights

Per-frame state. The full type is exported via `@bezier-sdf/core/renderers`. The renderer picks one of four composition modes from the fields you pass:

- **Legacy smin** (used by `examples/reveal`): pass `color` alone. All paths smooth-union into one silhouette painted with `color`. `sminK` controls the soft-union radius.
- **Per-path composite** (typical for arbitrary user SVGs): pass `pathModes`, `pathFillColors`, `pathStrokeColors`, `pathStrokeHalfW`. Paths render in document order with Porter-Duff "over" at rest and smin-fuse with color blending under cursor/ripple effects.
- **Glass**: pass `glass: true`. Requires the renderer to have been init'd with a `backdrop`. Refraction, chromatic aberration, frost blur, Fresnel rim, and tint are tunable via the `refractionStrength`, `chromaticStrength`, `frostStrength`, `fresnelStrength`, `tintStrength`, `rimColor`, and `tintColor` uniforms. Per-path colors and `pathOffsets` are ignored. Pair with `morph` (and a renderer init'd with both `backdrop` and `morphTo`) to refract through a morphing silhouette; the glass shader samples the two morph SDFs and blends them per fragment by `morph.t`.
- **Morph**: pass `morph: { t, colorA, colorB, pathColorsA?, pathColorsB? }`. Requires the renderer to have been init'd with `morphTo`. `t ∈ [0, 1]` lerps the two SDFs. By default each pixel's color is looked up from the bake's path-index map using the matching entry in `pathColorsA` / `pathColorsB`, then lerped by `t`, so per-path SVG colors are preserved across the transition. Omit a side's `pathColors*` to flatten that side to its `colorA` / `colorB` instead (mixed mode is supported). When `glass: true` is also set the standalone morph pipeline is bypassed and the glass shader takes over the SDF blend; the same per-path lookup drives the glass interior tint, with the same flat-override rules.

Optional shared deformations: `cursor` / `cursorPull` / `cursorRadius` (Gaussian pull toward a point) and `ripples` (up to 4 concurrent shockwave rings, each `[x, y, age, amplitude]`). Active in legacy and per-path modes; ignored in morph and applied subtly inside glass.

`pathOffsets` is required in legacy and per-path modes. Pass `[[0, 0], ...]` (length equal to `mark.paths.length`) to render the mark in its baked position; offset entries individually to slide paths around.

### Canvas helpers

```ts
import {
  makeTransform,   // logo-space to canvas-pixel transform
  buildMark,       // Path2D per path + combined
  buildMaskPixels, // RGBA mask for per-pixel effects
  perturbPath,     // breathing-outline primitive
} from '@bezier-sdf/core/canvas';
```

These do not need WebGL/WebGPU at all. They are for effects that want per-pixel control, like particle systems clipped to the silhouette or animated outlines drawn with `CanvasRenderingContext2D`.

## Browser support

| Backend       | Requirement                                                                  |
|---------------|------------------------------------------------------------------------------|
| WebGPU        | Chrome/Edge 113+, Safari 26+, Firefox 141+ (desktop). Roughly 70% of traffic |
| WebGL baked   | WebGL 1 + `OES_texture_half_float` + `EXT_color_buffer_half_float`           |
| WebGL direct  | WebGL 1 + `OES_standard_derivatives` (no animation, no per-path effects)     |

`createRenderer('auto')` cascades WebGPU then WebGL automatically and only throws if both fail. When `'auto'` falls back from WebGPU to WebGL, the WebGPU error is surfaced on the result as `fallbackFrom.error` so callers can route it to telemetry without crashing the page.

## License

MIT. See [LICENSE](./LICENSE).
