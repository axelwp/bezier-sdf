# @bezier-sdf/core

Framework-agnostic GPU signed-distance-field rendering of cubic Bezier curves. Trace a logo in Inkscape or Figma, feed the path into `parseSvgPath`, and render it as a crisp anti-aliased silhouette on WebGPU or WebGL.

```bash
npm install @bezier-sdf/core
```

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

Trace your logo in Inkscape (`Path → Simplify` keeps segment count low), export as Plain SVG, grab the `d` attribute of your `<path>`:

```ts
import { createRenderer, parseSvgPath, normalizeMark } from '@bezier-sdf/core';

const source = parseSvgPath('M 10 10 C 20 20, 40 20, 50 10 Z ...');
const { mark } = normalizeMark(source); // fit into [-1, 1]

const { renderer } = await createRenderer('auto', { canvas, mark });
```

The `mark.paths` array is what the renderer animates — give each path its own entry in `pathOffsets` and translate them independently to get the split-morph intro effect (see [the repo's reveal example](../../examples/reveal)).

## What it does

Every major rendering library computes vector shapes on the CPU and uploads triangulated results to the GPU. That's fine for static scenes, but it scales badly for animation — every frame where the shape changes needs a re-tessellation, re-upload, and re-rasterization.

`@bezier-sdf/core` skips all of that. The shape's cubic Bezier curves are the direct input to a GPU shader, which:

1. **Bakes** each path's signed-distance field into a half-float texture once at init. This is the expensive step — it evaluates "distance from this pixel to the nearest point on any Bezier in this path" for a 1024×1024 grid. Takes roughly one frame.
2. **Samples** those textures every frame at animation-translated UVs and smooth-unions the results. This is the cheap step — per-pixel cost collapses from ~800 ops to two texture reads plus a polynomial smooth-min.

The result: smooth animation of complex vector shapes without re-tessellation, with perfect anti-aliasing at any zoom (the shape is a distance field, not a triangle mesh, so `fwidth`-based AA gives you sub-pixel edges for free).

### Mark-to-mark morph

For shape-to-shape interpolation, the renderer offers a separate **flatten-then-bake** pipeline. Both marks have all of their paths concatenated and baked into a single combined SDF per side; the morph fragment shader samples both textures and lerps `mix(dA, dB, t)` per pixel. The result is a single unified silhouette that flows from shape A to shape B as `t` advances from 0 to 1.

The bake distinguishes fill paths from stroke paths internally: filled subpaths use per-path even-odd parity, stroked subpaths bake as sausage SDFs (`pathMinD − strokeWidth/2`). Both produce proper signed fill SDFs that union via `min()` into a coherent silhouette — so SVGs that mix fills and strokes (icons with a circle plus stroked accents, line-art with closed and open subpaths, etc.) morph correctly without parity garbage from the open subpaths leaking into the result.

Activate by passing `morphTo` and (optionally) `morphFillRule` to `renderer.init`, then per-frame uniforms include `morph: { t, colorA, colorB }`.

See [`docs/technique.md`](../../docs/technique.md) in the repo for the full writeup.

## API

### Geometry

```ts
import {
  parseSvgPath,     // SVG <path d="..."> → Mark
  normalizeMark,    // center + scale to fit [-1, 1]
  sampleBezierPath, // N points along a path (for polyline tweens)
  evalCubic,        // single-segment evaluation at t
  DEMO_MARK,        // built-in demo: two rounded chevrons
} from '@bezier-sdf/core/geometry';
```

### Renderers

```ts
import {
  createRenderer,   // factory with WebGPU → WebGL fallback
  WebGPURenderer,   // direct access if you want to skip the factory
  WebGLRenderer,
} from '@bezier-sdf/core/renderers';
```

Every renderer implements the same interface:

```ts
interface Renderer {
  kind: 'webgpu' | 'webgl';
  mode: 'baked' | 'direct';   // WebGL can fall back to direct if half-float missing
  pathCount: number;
  init(opts: RendererInitOptions): Promise<void>;
  render(uniforms: Uniforms): void;
  rebake(mark: Mark): void;          // re-run bake with new geometry; structural shape must match init
  setBackdrop(source: TexImageSource): void;  // hot-swap glass backdrop on resize/dpi change
  dispose(): void;
}
```

#### `RendererInitOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `canvas` | `HTMLCanvasElement` | *required* | Target canvas. The renderer takes ownership of its GPU context. |
| `mark` | `Mark` | *required* | Geometry. For morph, this is shape A. |
| `backdrop` | `TexImageSource` | *none* | Image to refract through the silhouette in liquid-glass mode. When omitted, the glass pipeline isn't compiled and `Uniforms.glass` is ignored. |
| `morphTo` | `Mark` | *none* | When set, switches the renderer into morph mode. The renderer flattens both `mark` and `morphTo` into a single SDF per side and compiles only the morph pipeline (per-path sample / direct pipelines are skipped). |
| `morphFillRule` | `'nonzero' \| 'evenodd'` | `'nonzero'` | Bake fill rule for both morph sides. `'nonzero'` (default) does per-path even-odd hard-unioned via `min()` — preserves intentional holes in a single path. `'evenodd'` does a single global crossing count across every segment; opt in only when the source artwork relies on cross-path subtractive parity. |

#### `Uniforms` highlights

Per-frame state. The full type is exported via `@bezier-sdf/core/renderers`. The renderer picks one of three composition modes from the fields you pass:

- **Legacy smin** (used by `examples/reveal`): pass `color` alone. All paths smooth-union into one silhouette painted with `color`. `sminK` controls the soft-union radius.
- **Per-path composite** (typical for arbitrary user SVGs): pass `pathModes`, `pathFillColors`, `pathStrokeColors`, `pathStrokeHalfW`. Paths render in document order with Porter-Duff "over" at rest, smin-fuse with color blending under cursor/ripple effects.
- **Morph**: pass `morph: { t, colorA, colorB }`. Renderer must have been init'd with `morphTo`. `t ∈ [0, 1]` lerps the SDFs and the silhouette color.

Optional shared deformations: `cursor` / `cursorPull` / `cursorRadius` (Gaussian pull toward a point) and `ripples` (up to 4 concurrent shockwave rings, each `[x, y, age, amplitude]`). Apply in legacy and per-path modes; ignored in morph and (subtly composed) in glass.

### Canvas helpers

```ts
import {
  makeTransform,   // logo-space → canvas-pixel transform
  buildMark,       // Path2D per path + combined
  buildMaskPixels, // RGBA mask for per-pixel effects
  perturbPath,     // breathing-outline primitive
} from '@bezier-sdf/core/canvas';
```

These don't need WebGL/WebGPU at all — they're for effects that want per-pixel control, like particle systems clipped to the silhouette or animated outlines drawn with `CanvasRenderingContext2D`.

## Browser support

| Backend | Requirement                                                  |
|---------|--------------------------------------------------------------|
| WebGPU  | Chrome/Edge 113+, Safari 26+, Firefox 141+ (desktop); 70% global |
| WebGL baked  | Any WebGL 1 + `OES_texture_half_float` + `EXT_color_buffer_half_float` |
| WebGL direct | Any WebGL 1 with `OES_standard_derivatives` (no animation)   |

`createRenderer('auto')` cascades through these automatically. Failed backends are logged via `console.info` and never thrown unless all three fail.

## License

MIT
