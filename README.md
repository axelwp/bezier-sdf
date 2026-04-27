<div align="center">

# bezier-sdf

**Render SVG logos as GPU signed-distance fields, straight from cubic Bezier curves.**

Smooth animation, crisp at any zoom, no re-tessellation per frame.
WebGPU primary, WebGL fallback, static SVG when neither is available.

<img src="./docs/assets/default-mark.png" alt="Two rounded chevrons facing each other" width="420" />

### [**→ Live demo**](https://axelwp.github.io/)

[![@bezier-sdf/react](https://img.shields.io/npm/v/@bezier-sdf/react.svg?label=%40bezier-sdf%2Freact)](https://www.npmjs.com/package/@bezier-sdf/react)
[![@bezier-sdf/core](https://img.shields.io/npm/v/@bezier-sdf/core.svg?label=%40bezier-sdf%2Fcore)](https://www.npmjs.com/package/@bezier-sdf/core)
[![license](https://img.shields.io/npm/l/@bezier-sdf/core.svg)](./LICENSE)

</div>

---

## Two ways in

This repo ships two npm packages. Pick the one that fits your project:

- **[`@bezier-sdf/react`](./packages/react)** is the headline package: a drop-in `<LiveGraphic>` component. Point it at an SVG URL, get a GPU-rendered silhouette with built-in intro animations, hover effects, ripples, glass material, and shape-to-shape morph. Glass and morph compose: drop in a second SVG via `to` and the backdrop refracts through a silhouette that smoothly morphs on hover. Handles fetch, parse, normalize, DPR, resize, `prefers-reduced-motion`, viewport pause, and static-SVG fallback for you. This is what most people want.

- **[`@bezier-sdf/core`](./packages/core)** is the framework-agnostic engine the React component is built on. Use it directly when you need lower-level control (custom render loops, non-React frameworks, your own pointer/scroll bindings, custom shaders). Requires more code and more familiarity with GPU rendering.

```bash
npm install @bezier-sdf/react @bezier-sdf/core   # React projects
npm install @bezier-sdf/core                     # everything else
```

## Quick start (React)

```tsx
import { LiveGraphic } from '@bezier-sdf/react';

export default function Logo() {
  return <LiveGraphic src="/logo.svg" effect="reveal" color="#ff3a7a" />;
}
```

That's it. The component fetches `/logo.svg`, parses it, normalizes to the bake region, picks the best available GPU backend, plays a reveal animation when it scrolls into view, and falls back to a static `<svg>` if both backends fail. See the [React package README](./packages/react/README.md) for every effect, prop, and tuning knob.

## Quick start (core)

When you want to drive the renderer yourself:

```ts
import { createRenderer, parseSvgPath, normalizeMark } from '@bezier-sdf/core';

const canvas = document.querySelector<HTMLCanvasElement>('#logo')!;
canvas.width = 800;
canvas.height = 800;

const raw = parseSvgPath('M 297 790 C -35 -10, ... Z M 518 790 C -46 -9, ... Z');
const { mark } = normalizeMark(raw);

const { renderer } = await createRenderer('auto', { canvas, mark });

renderer.render({
  width: canvas.width,
  height: canvas.height,
  zoom: 1, offsetX: 0, offsetY: 0,
  pathOffsets: [[0, 0], [0, 0]],
  sminK: 0.08,
  color: [1, 0.23, 0.48],
  opacity: 1,
});
```

Full API is in the [core package README](./packages/core/README.md).

## Why

Most browser vector libraries (SVG, Canvas, Pixi, Lottie) work the same way under the hood: take Bezier curves, triangulate them on the CPU, upload the triangles to the GPU, rasterize. That works for static scenes, but it scales poorly for animation. Every frame where the shape *changes* needs a fresh tessellation, a fresh upload, and a fresh rasterization. A logo reveal in Lottie burns a budget that a static SVG never would.

This library takes the other path. The Bezier curves *are* the input to the GPU shader, which computes "distance from this pixel to the nearest point on any curve" directly. No triangles, no CPU tessellation, no intermediate mesh. The shape is a [signed distance field](https://iquilezles.org/articles/distfunctions2d/) defined by the curves themselves.

Two consequences:

- **Perfect anti-aliasing at any zoom.** An SDF tells you sub-pixel distance to the edge, so `fwidth`-based AA gives you an edge that's one pixel wide whether the logo is 32px or filling a 4K display.
- **Animation is cheap.** Re-rendering with a different transform is "sample the texture at translated UVs and smooth-union." Your GPU can do thousands of those per frame without breathing hard.

The catch: computing distance to a cubic Bezier is [non-trivial](https://iquilezles.org/articles/distfunctions2d/) (Newton-iterating on a quintic), so the naive shader is expensive. This library bakes each path's SDF into a texture *once* at init. The expensive step happens on the first frame; every frame after that is a couple of texture samples. You get the animation flexibility without paying the per-pixel cost.

## Packages

| Package | What it is | When to reach for it |
|---|---|---|
| [`@bezier-sdf/react`](./packages/react) | Drop-in `<LiveGraphic>` React component with built-in effects (`reveal`, `ripple`, `liquid-cursor`, `liquid-glass`, `morph`), automatic fallback, and Next.js/SSR-friendly patterns. | React apps. The default choice. |
| [`@bezier-sdf/core`](./packages/core) | Framework-agnostic engine: WebGPU + WebGL renderers, SVG path parser, geometry helpers, Canvas 2D primitives. | Non-React frameworks, custom render loops, building your own component, or extending the renderer. |

## Repo layout

```
bezier-sdf/
├── packages/
│   ├── core/                ← engine: renderers, parser, geometry  (@bezier-sdf/core)
│   └── react/               ← <LiveGraphic> component              (@bezier-sdf/react)
├── examples/                ← standalone Vite apps, one per technique
│   ├── reveal/              ← split-and-merge intro animation
│   ├── morph/               ← shape-to-shape morph between two SVGs
│   ├── liquid-cursor/       ← silhouette bulges toward the pointer
│   ├── liquid-glass/        ← refractive lens material over a backdrop
│   └── react/               ← <LiveGraphic> playground
└── docs/
    └── technique.md         ← the math + the rendering pipeline writeup
```

## Examples

Each folder under [`examples/`](./examples) is a standalone Vite app that depends on the local packages via the workspace link. Edit a package source file; the example hot-reloads.

<div align="center">

https://github.com/user-attachments/assets/79373986-fb38-4aac-8bc8-e926ca45585c

<sub><code>examples/reveal</code>. Run with <code>pnpm --filter @bezier-sdf/example-reveal dev</code></sub>

</div>

| Example          | Technique                                                                 |
|------------------|---------------------------------------------------------------------------|
| `reveal`         | Split-and-merge intro: sub-paths start displaced, slide to final positions on scroll-into-view |
| `morph`          | Hover-driven interpolation between two traced SVGs via combined-SDF lerp; each source path keeps its SVG color through the transition |
| `liquid-cursor`  | Pointer-tracking inverse-square pull bulges the silhouette toward the cursor |
| `liquid-glass`   | Refractive glass material with chromatic aberration, frost blur, and Fresnel rim |
| `react`          | `<LiveGraphic>` playground showing every preset and prop                  |

## Local development

Requires [pnpm](https://pnpm.io/) and Node 18+.

```bash
pnpm install          # install everything
pnpm build            # build all packages
pnpm dev:examples     # run every example in parallel
```

Run a single example:

```bash
pnpm --filter @bezier-sdf/example-reveal dev
```

## Seen in the wild

This library powers the logo reveal on [levx.trade](https://levx.trade), a chart-line-to-logo morph that demonstrates the polyline sampling pattern in production. The technique is documented in [`docs/technique.md`](./docs/technique.md#the-chart-to-logo-morph-pattern).

If you ship `@bezier-sdf/*` somewhere public, open a PR adding it here.

## Contributing

Pull requests welcome, particularly:

- Additional SVG command support (`A` arc conversion via cubic approximation)
- Vue / Svelte / Solid bindings as `@bezier-sdf/<framework>` packages
- More renderer backends (canvas-based offscreen 2D for testing)
- New built-in effects for `<LiveGraphic>`

## License

MIT. See [LICENSE](./LICENSE).
