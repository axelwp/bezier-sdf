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
  mode: 'baked' | 'direct';  // WebGL can fall back to direct if half-float missing
  pathCount: number;
  init(opts: { canvas, mark }): Promise<void>;
  render(uniforms: Uniforms): void;
  dispose(): void;
}
```

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
