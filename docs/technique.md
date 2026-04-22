# Technique: Bezier → SDF → texture

This is the writeup that makes the rest of the codebase make sense. It walks through why the problem is hard, which tricks the library uses, and what trade-offs those tricks involve. If you understand this doc, you can read any file in `packages/core/src/` and know what it's doing.

## Starting point: what is a signed distance field?

A 2D signed distance field (SDF) is a function `d(x, y)` that returns:

- `d < 0` when the point is inside the shape,
- `d > 0` when it's outside,
- `|d|` equal to the distance to the nearest point on the boundary.

SDFs are cheap to render: a fragment shader computes `d` at each pixel and colors it accordingly. Crucially, the *edge* is at `d = 0`, so anti-aliasing is just `smoothstep(-w, w, d)` for a pixel-width `w`. No multisampling, no jaggies, no triangles.

The catch: computing `d` for a complicated shape is expensive. If the shape is a circle, `d(x, y) = sqrt(x² + y²) - r` — trivial. If it's a polygon, you loop over edges and take the minimum, still fast. But if it's a Bezier-defined curve (like every logo in the world), each evaluation needs an iterative solver.

## Distance to a cubic Bezier

A cubic Bezier segment is parameterized by `t ∈ [0, 1]`:

```
B(t) = (1-t)³ P₀ + 3(1-t)²t P₁ + 3(1-t)t² P₂ + t³ P₃
```

To find the closest point on the segment to an arbitrary `p`, we need to solve:

```
f(t) = (B(t) - p) · B'(t) = 0
```

That's a **quintic in t** — no closed form. The options are:

1. **Analytic approximation** (Inigo Quilez has published a quartic approximation that works for many cases).
2. **Numerical iteration.** Start from a coarse sample, refine with Newton's method.

This library uses option 2:

```glsl
// (simplified from shaders/webgl.ts)
float bestT = 0.0;
float bestD2 = 1e20;

// Coarse pass — 12 samples along the curve
for (int i = 0; i <= 12; i++) {
  float t = float(i) / 12.0;
  vec2 b = bezier(P0, P1, P2, P3, t);
  float d2 = dot(b - p, b - p);
  if (d2 < bestD2) { bestD2 = d2; bestT = t; }
}

// 3 Newton iterations to refine
for (int i = 0; i < 3; i++) {
  vec2 b = bezier(P0, P1, P2, P3, bestT);
  vec2 db = bezier_deriv(P0, P1, P2, P3, bestT);
  vec2 diff = b - p;
  float f = dot(diff, db);
  float fp = dot(db, db) + dot(diff, ddb);
  bestT = clamp(bestT - f / fp, 0.0, 1.0);
}
```

That's ~15 bezier evaluations per segment per pixel. For a 26-segment logo at 1080², that's ~40 million bezier evaluations per frame — about 800 floating-point operations per pixel. Modern GPUs eat this for breakfast, but it's not nothing.

## Finding "inside vs outside"

Distance alone is unsigned. To get the *sign*, we need to know whether the pixel is inside the outline. The classic trick: shoot a ray from the pixel horizontally to the right, count how many times it crosses the shape's boundary. Odd count → inside, even count → outside. This is the [even-odd fill rule](https://en.wikipedia.org/wiki/Even%E2%80%93odd_rule), same as SVG uses.

For each segment, we sample the curve at 16 points along `t` and count how many y-crossings occur to the right of the pixel:

```glsl
for (int i = 1; i <= 16; i++) {
  float t = float(i) / 16.0;
  vec2 b = bezier(P0, P1, P2, P3, t);
  float y = b.y - p.y;
  if ((prevY <= 0 && y > 0) || (prevY > 0 && y <= 0)) {
    // y-crossing — is it to the right of p?
    float s = prevY / (prevY - y);
    float xc = mix(prevX, b.x, s);
    if (xc > p.x) crossings++;
  }
  prevY = y;
  prevX = b.x;
}
```

At the end, if `crossings` is odd, we flip the sign of the distance.

Put together, the per-pixel algorithm is:

```
for each segment:
  unsigned_d = min(unsigned_d, distToCubic(p, segment))
  crossings += rayCrossings(p, segment)
signed_d = (crossings % 2 == 1) ? -unsigned_d : unsigned_d
```

This is `sceneSDF()` in the shader. It's correct, scales linearly with segment count, and is the fundamental primitive underneath everything the library does.

## The performance trick: bake once, sample forever

At this point you can render a static logo beautifully. But if you want to *animate* (translate, rotate, morph), the naive approach is to re-evaluate the whole thing every frame. 800 ops per pixel × 2M pixels × 60fps = 100 billion ops/sec, which is a lot even for a GPU.

Here's the key realization: **the SDF only depends on the shape, not the camera.** If you translate the camera by `(dx, dy)`, the SDF stays the same — you just sample it at `p - (dx, dy)`. So we can precompute the SDF once into a texture, and then every frame is just a texture lookup.

That's exactly what the bake pass does:

1. Create a 1024×1024 half-float render target.
2. Run the `sceneSDF()` shader with the target's UVs spanning `[-1.2, 1.2]` (the "bake bound" — covers the `[-1, 1]` logo with margin for animation).
3. Write the signed distance to the R channel.

Now rendering is:

```glsl
float d = texture2D(u_sdf, uv_to_texture_coords(p - offset)).r;
float mask = 1.0 - smoothstep(-aa, aa, d);
```

Per-pixel cost drops from ~800 ops to about 4. You can easily render at 8K.

## Per-path baking for split animations

If you bake the *whole mark* into one texture, you can translate the whole thing together but you can't animate sub-shapes independently. For a logo made of two letters that should slide in from different directions, you want each letter in its own texture.

The library bakes each path separately (`WebGLRenderer.bakeOne()` in a loop, `WebGPURenderer.bakeShape()` in a loop). Then the sample shader reads all of them:

```glsl
float d0 = sampleAt(u_sdf0, uv, u_pathOffset0);
float d1 = sampleAt(u_sdf1, uv, u_pathOffset1);
// ...
float d = smin(d0, smin(d1, d2, k), k);
```

`smin` is a polynomial smooth-min (from Inigo Quilez): when `|d0 - d1| < k` the result eases between them instead of taking the hard minimum. The visible effect when two paths come close is a "fluid bridge" that makes the separation and re-joining look organic rather than geometric.

## The chart-to-logo morph pattern

Sometimes you want to transition from a completely different starting shape into the logo. The SDF approach doesn't help directly (a chart line has no SDF of its own). The library includes a polyline-sampling utility for this case:

1. Sample the logo path at N evenly-spaced points in `t`-parameter space (`sampleBezierPath`).
2. Compute the N source positions however you like (noise, chart, sine wave).
3. Lerp between source[i] and target[i] over the animation, drawing as a polyline on Canvas 2D.
4. In the final 15% of the animation, **crossfade to the exact Bezier stroke** — same vertex positions, but now it's a real `bezierCurveTo` instead of a chord approximation. Without this crossfade, the handoff shows a visible "snap" where the polyline was ~2px inside the tight curve sections.

The crossfade is done with additive blending: both layers at partial alpha, summing to 1 across the transition. The polyline fades out, the Bezier stroke fades in, total brightness stays constant.

## Why not MSDF?

[Multi-channel signed distance fields](https://github.com/Chlumsky/msdfgen) are the other common GPU vector-rendering technique — used by every game engine for text. They bake an SDF to a low-resolution texture (typically 32-64px per glyph) and use the RGB channels to preserve sharp corners at extreme zoom.

MSDF is *better* than what this library does for text, where you need thousands of glyphs and extreme zoom range. It's *worse* for what we're doing, because:

- **Our texture is 1024×1024 for a single logo.** MSDF's sharpness trick matters when you're at 32px; at 1024px there are enough pixels along the edge that single-channel SDF with linear filtering is already pixel-perfect.
- **MSDF's per-glyph baking is complex** (edge coloring, contour assignment). Our full SDF bake is one shader pass.
- **We want the freedom to do smooth-min between paths.** That requires real signed distances, not the RGB-encoded contour hints MSDF stores.

Different tools for different jobs. If you want to render a whole font, use MSDF. If you want to render a logo with animation, do what this library does.

## Limits and when to use something else

- **Segment count.** The shader loops over all segments for every pixel. At 26 segments it's fine; at 200 segments you'll want spatial partitioning (bounding boxes per segment, grid acceleration structure) — this library doesn't do that.
- **Self-intersections.** The ray-crossing inside test assumes a simple (non-self-intersecting) closed path. Shapes with holes or crossings need the non-zero winding rule, which this library doesn't implement.
- **Animation of the shape itself.** Once baked, the texture is frozen. You can translate, rotate, scale, and smooth-union paths, but you can't move individual control points without re-baking. If you need *topological* animation (shape A morphing into shape B, two circles merging), use the polyline-sampling trick with a crossfade to the final bake.
- **Very thin strokes.** The distance field approximates the shape at texture resolution, so a stroke thinner than `1 / 1024` of the bake bound will alias. Either thicken the stroke or increase bake size.

For most logo-rendering use cases these aren't problems. They're the reasons the library has a scope — a catalog of what it's good at.
