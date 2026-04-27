/**
 * WGSL shaders for the WebGPU renderer. Same algorithm as the GLSL
 * version — bake SDFs per path, then sample + either smooth-union
 * (legacy single-color mode used by the reveal example) or composite
 * per-path fill/stroke layers (used for arbitrary user SVGs).
 */

export const WEBGPU_BAKE_SIZE = 1024;
export const WEBGPU_BAKE_BOUND = 1.2;

/**
 * Upper bound on paths per mark. Mirrors the GLSL shader's MAX_PATHS;
 * raising this lets multi-subpath `<path>` elements (rings, holes,
 * compound icons) render every subpath. Each adds one sampled-texture
 * binding to both the sample and glass bind groups.
 */
export const MAX_PATHS = 16;
/** Number of vec4 slots that hold MAX_PATHS packed scalars (u32 or f32). */
const PATH_V4 = MAX_PATHS / 4;

/**
 * Uniform buffer layout for the sample pipeline. Computed per WGSL's
 * layout rules (vec3 align 16 / size 12; array<vec4<T>, N> align 16
 * stride 16 — `array<vec2, N>` would need stride 16 too, so we pack
 * two vec2 per vec4 instead).
 *
 *   resolution         : vec2<f32>   // 0
 *   zoom               : f32         // 8
 *   sminK              : f32         // 12
 *   offset             : vec2<f32>   // 16
 *   compositeMode      : u32         // 24
 *   pathCount          : u32         // 28
 *   color              : vec3<f32>   // 32  (vec3 needs align 16)
 *   opacity            : f32         // 44
 *   bound              : f32         // 48
 *   _pad0              : f32         // 52
 *   cursor             : vec2<f32>   // 56
 *   cursorPull         : f32         // 64
 *   cursorRadius       : f32         // 68
 *   _padR              : vec2<f32>   // 72
 *   ripples            : array<vec4<f32>, 4>      // 80   (64B)
 *   pathMode           : array<vec4<u32>, PATH_V4>// 144  (PATH_V4*16)
 *   pathStrokeHalfW    : array<vec4<f32>, PATH_V4>// 208
 *   pathFillOpacity    : array<vec4<f32>, PATH_V4>// 272
 *   pathStrokeOpacity  : array<vec4<f32>, PATH_V4>// 336
 *   pathFillColor      : array<vec4<f32>, MAX>    // 400  (MAX_PATHS*16)
 *   pathStrokeColor    : array<vec4<f32>, MAX>    // 400 + MAX*16
 *   pathOffsets        : array<vec4<f32>, MAX/2>  // last — two vec2 per vec4
 */
const SAMPLE_OFF = {
  resolution: 0,
  zoom: 8,
  sminK: 12,
  offset: 16,
  compositeMode: 24,
  pathCount: 28,
  color: 32,
  opacity: 44,
  bound: 48,
  cursor: 56,
  cursorPull: 64,
  cursorRadius: 68,
  ripples: 80,
  pathMode: 80 + 64,
  pathStrokeHalfW: 80 + 64 + PATH_V4 * 16,
  pathFillOpacity: 80 + 64 + PATH_V4 * 16 * 2,
  pathStrokeOpacity: 80 + 64 + PATH_V4 * 16 * 3,
  pathFillColor: 80 + 64 + PATH_V4 * 16 * 4,
  pathStrokeColor: 80 + 64 + PATH_V4 * 16 * 4 + MAX_PATHS * 16,
  pathOffsets: 80 + 64 + PATH_V4 * 16 * 4 + MAX_PATHS * 16 * 2,
} as const;

export const WEBGPU_SAMPLE_OFFSETS = SAMPLE_OFF;
export const WEBGPU_SAMPLE_UNIFORM_SIZE =
  SAMPLE_OFF.pathOffsets + (MAX_PATHS / 2) * 16;

/**
 * Uniform buffer layout for the glass sample pipeline — no compositeMode
 * / paint-color inputs, but carries the refraction/fresnel/tint scalars
 * and still needs the full per-path mode+strokeHalfW+offsets for strokes.
 *
 * `dynamicSdf` (u32 0/1) and `blendT` (f32) drive the dynamic-SDF mode:
 * when set, the lens SDF at each pixel is `mix(sample(sdf0), sample(sdfB),
 * blendT)` instead of the per-path smin union — used for glass-on-morph
 * composition (and any future effect that wants a blended-SDF source).
 *
 * In dynamic-SDF (glass+morph) mode, the tint that's normally a single
 * `tintColor` becomes per-pixel: each side's path-index texture is
 * sampled, the matching `pathColorsA/B` entry looked up, and the two
 * tints lerped by `blendT`. `useOverrideA/B` bypasses the lookup with
 * `morphColorA/B` (or falls back to plain glass tint when both are
 * unset). Plain glass mode (`dynamicSdf == 0`) is unchanged.
 */
const _GLASS_OFF_END = 160 + PATH_V4 * 16 * 2 + (MAX_PATHS / 2) * 16;
const GLASS_OFF = {
  resolution: 0,
  zoom: 8,
  sminK: 12,
  offset: 16,
  pathCount: 24,
  opacity: 28,
  refractionStrength: 32,
  chromaticStrength: 36,
  fresnelStrength: 40,
  tintStrength: 44,
  rimColor: 48,    // vec3 @ 48..60
  bound: 60,
  tintColor: 64,   // vec3 @ 64..76
  frostStrength: 76,
  cursor: 80,
  cursorPull: 88,
  cursorRadius: 92,
  ripples: 96,                                    // 96..160   (64B)
  pathMode: 160,                                  // 160..160+PATH_V4*16
  pathStrokeHalfW: 160 + PATH_V4 * 16,            // next
  pathOffsets: 160 + PATH_V4 * 16 * 2,            // two vec2 per vec4
  dynamicSdf: _GLASS_OFF_END,
  blendT: _GLASS_OFF_END + 4,
  useOverrideA: _GLASS_OFF_END + 8,
  useOverrideB: _GLASS_OFF_END + 12,
  // morphColorA/B are vec3<f32>, aligned to 16; placed at the next vec4
  // slot so WGSL struct alignment is satisfied.
  morphColorA: _GLASS_OFF_END + 16,    // .. + 28
  morphColorB: _GLASS_OFF_END + 32,    // .. + 44
  pathColorsA: _GLASS_OFF_END + 48,
  pathColorsB: _GLASS_OFF_END + 48 + MAX_PATHS * 16,
} as const;

export const WEBGPU_GLASS_OFFSETS = GLASS_OFF;
// Pad to vec4 alignment so the buffer size is a multiple of 16; WGSL
// requires array elements / total struct sizes to round up to that.
export const WEBGPU_GLASS_UNIFORM_SIZE =
  GLASS_OFF.pathColorsB + MAX_PATHS * 16;

/**
 * Uniform buffer layout for the morph pipeline. Two textures (one
 * combined SDF per side) sampled and lerped by `morphT`; per-path
 * colors looked up from the path-index textures preserve each region's
 * intrinsic SVG color through the morph. `useOverrideA/B` falls back
 * to flat `colorA/colorB` when the caller supplies a single-color
 * override (the React `color`/`toColor` props, or the legacy 2-color
 * morph API).
 *
 *   resolution     : vec2<f32>            //   0
 *   zoom           : f32                  //   8
 *   morphT         : f32                  //  12
 *   offset         : vec2<f32>            //  16
 *   opacity        : f32                  //  24
 *   bound          : f32                  //  28
 *   colorA         : vec3<f32>            //  32  (vec3 needs align 16)
 *   useOverrideA   : u32                  //  44
 *   colorB         : vec3<f32>            //  48
 *   useOverrideB   : u32                  //  60
 *   pathColorsA    : array<vec4<f32>, MAX_PATHS>   // 64
 *   pathColorsB    : array<vec4<f32>, MAX_PATHS>   // 64 + MAX_PATHS*16
 */
const MORPH_OFF = {
  resolution: 0,
  zoom: 8,
  morphT: 12,
  offset: 16,
  opacity: 24,
  bound: 28,
  colorA: 32,
  useOverrideA: 44,
  colorB: 48,
  useOverrideB: 60,
  pathColorsA: 64,
  pathColorsB: 64 + MAX_PATHS * 16,
} as const;
export const WEBGPU_MORPH_OFFSETS = MORPH_OFF;
export const WEBGPU_MORPH_UNIFORM_SIZE = 64 + MAX_PATHS * 16 * 2;

/**
 * Bake-shader uniform layout. Mirrors the GLSL bake's u_pathCount /
 * u_pathEnds / u_pathMode / u_pathHalfW / u_fillRule. WGSL uniform-array
 * stride is 16 bytes so MAX_PATHS values are packed four-wide into
 * ${MAX_PATHS / 4} vec4<u32>/vec4<f32> slots; pathEnds(i) etc. return
 * the i-th value via the indexed accessor.
 *
 * `outputMode` selects what the bake fragment shader writes:
 *   0 — signed distance (default).
 *   1 — winning path index, normalized to [0, 1] for r16float storage.
 * Two-pass per side (distance + path-index) lets render shaders sample
 * a per-pixel ownership map alongside the SDF and look up per-path
 * colors from a uniform array — preserves source SVG region colors
 * through the morph's unified-silhouette bake.
 */
const BAKE_OFF = {
  pathCount: 0,
  fillRule: 4,
  outputMode: 8,
  pathEnds:  16,
  pathMode:  16 + (MAX_PATHS / 4) * 16,
  pathHalfW: 16 + (MAX_PATHS / 4) * 16 * 2,
} as const;
export const WEBGPU_BAKE_OFFSETS = BAKE_OFF;
export const WEBGPU_BAKE_UNIFORM_SIZE = BAKE_OFF.pathHalfW + (MAX_PATHS / 4) * 16;

/**
 * Bake shader. A storage buffer of (P0, P1, P2, P3) cubics gets uploaded
 * per bake pass; the fragment shader walks them for each pixel of a
 * 1024x1024 r16float render target.
 *
 * The combined SDF over multiple paths is built with one of two fill
 * rules (see GLSL twin's SDF_BODY for the full rationale):
 *   0 (nonzero) — per-path even-odd, hard-unioned via min(). Default;
 *     preserves intentional holes inside a single path (the inside of
 *     an "O") while a path's segments crossing through another path's
 *     interior cannot subtract from that path's fill region.
 *   1 (evenodd) — single global crossing count across every segment.
 *     Required only when source artwork relies on cross-path even-odd
 *     subtraction.
 *
 * For non-morph bakes (one path at a time) pathCount=1 and the two
 * rules produce identical output; the renderer still binds these
 * uniforms because the layout requires them.
 */
export const WEBGPU_BAKE_SHADER = /* wgsl */ `
struct Segment {
  a: vec4<f32>, // (P0, P1)
  b: vec4<f32>, // (P2, P3)
};
struct BakeParams {
  pathCount: u32,
  fillRule: u32,
  outputMode: u32,
  _pad: u32,
  pathEnds:  array<vec4<u32>, ${MAX_PATHS / 4}>,
  pathMode:  array<vec4<u32>, ${MAX_PATHS / 4}>,
  pathHalfW: array<vec4<f32>, ${MAX_PATHS / 4}>,
};

@group(0) @binding(0) var<storage, read> segments: array<Segment>;
@group(0) @binding(1) var<uniform> bake: BakeParams;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var out: VsOut;
  out.pos = vec4<f32>(pos[vi], 0.0, 1.0);
  // Bake region is [-BOUND, BOUND]². Fullscreen triangle covers [-1, 3],
  // so we scale by BOUND here; only the [-1, 1] quad portion is visible
  // in the render target.
  out.uv = pos[vi] * ${WEBGPU_BAKE_BOUND};
  return out;
}

fn bezier(p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>, t: f32) -> vec2<f32> {
  let u = 1.0 - t;
  return u*u*u * p0 + 3.0*u*u*t * p1 + 3.0*u*t*t * p2 + t*t*t * p3;
}
fn bezier_deriv(p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>, t: f32) -> vec2<f32> {
  let u = 1.0 - t;
  return 3.0*u*u * (p1 - p0) + 6.0*u*t * (p2 - p1) + 3.0*t*t * (p3 - p2);
}

fn dist_to_cubic(p: vec2<f32>, p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>) -> vec2<f32> {
  var crossings: f32 = 0.0;
  var prevY = p0.y - p.y;
  var prevX = p0.x;
  for (var i: i32 = 1; i <= 16; i = i + 1) {
    let t = f32(i) / 16.0;
    let b = bezier(p0, p1, p2, p3, t);
    let y = b.y - p.y;
    let crossed = (prevY <= 0.0 && y > 0.0) || (prevY > 0.0 && y <= 0.0);
    if (crossed) {
      let s = prevY / (prevY - y);
      let xc = mix(prevX, b.x, s);
      if (xc > p.x) { crossings = crossings + 1.0; }
    }
    prevY = y;
    prevX = b.x;
  }
  var bestT: f32 = 0.0;
  var bestD2: f32 = 1e20;
  for (var i: i32 = 0; i <= 12; i = i + 1) {
    let t = f32(i) / 12.0;
    let b = bezier(p0, p1, p2, p3, t);
    let d2 = dot(b - p, b - p);
    if (d2 < bestD2) { bestD2 = d2; bestT = t; }
  }
  for (var i: i32 = 0; i < 3; i = i + 1) {
    let b = bezier(p0, p1, p2, p3, bestT);
    let db = bezier_deriv(p0, p1, p2, p3, bestT);
    let diff = b - p;
    let u = 1.0 - bestT;
    let ddb = 6.0 * u * (p2 - 2.0 * p1 + p0) + 6.0 * bestT * (p3 - 2.0 * p2 + p1);
    let f = dot(diff, db);
    let fp = dot(db, db) + dot(diff, ddb);
    if (abs(fp) > 1e-8) {
      bestT = clamp(bestT - f / fp, 0.0, 1.0);
    }
  }
  let bfinal = bezier(p0, p1, p2, p3, bestT);
  return vec2<f32>(length(bfinal - p), crossings);
}

fn pathEnd(i: u32) -> u32 {
  return bake.pathEnds[i / 4u][i % 4u];
}
fn pathMode(i: u32) -> u32 {
  return bake.pathMode[i / 4u][i % 4u];
}
fn pathHalfW(i: u32) -> f32 {
  return bake.pathHalfW[i / 4u][i % 4u];
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  // Flip Y — our geometry uses +y up, render targets use +y down.
  let p = vec2<f32>(uv.x, -uv.y);

  if (bake.fillRule == 1u) {
    // Even-odd across every segment in the bake — global parity (legacy).
    // No per-path notion in this mode, so winning path index is always 0.
    var minD: f32 = 1e20;
    var crossings: f32 = 0.0;
    let count = arrayLength(&segments);
    for (var i: u32 = 0u; i < count; i = i + 1u) {
      let seg = segments[i];
      let r = dist_to_cubic(p, seg.a.xy, seg.a.zw, seg.b.xy, seg.b.zw);
      if (r.x < minD) { minD = r.x; }
      crossings = crossings + r.y;
    }
    let inside = (i32(crossings) % 2) == 1;
    let signed_d = select(minD, -minD, inside);
    if (bake.outputMode == 1u) {
      return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    return vec4<f32>(signed_d, 0.0, 0.0, 1.0);
  }

  // Nonzero (default): per-path even-odd, hard-unioned via min(). Outer
  // loop bound is MAX_PATHS; runtime pathCount and per-path span drive
  // the early exits. Total inner iterations sum to the total segment
  // count — same work as the global loop, partitioned per path.
  //
  // Stroked paths (pathMode == 1) bypass even-odd and use the sausage
  // SDF (pathMinD - halfW) — open subpaths in stroked SVGs would
  // otherwise produce garbage parity that corrupts the union.
  //
  // winningPathIdx tracks which path produced the smallest signed
  // distance at this fragment — used by outputMode == 1u (path-index
  // pass) to emit a per-pixel ownership map for downstream per-path
  // color lookup.
  var result: f32 = 1e20;
  var winningPathIdx: u32 = 0u;
  var prevEnd: u32 = 0u;
  for (var p_i: u32 = 0u; p_i < ${MAX_PATHS}u; p_i = p_i + 1u) {
    if (p_i >= bake.pathCount) { break; }
    let segEnd = pathEnd(p_i);
    var pathMinD: f32 = 1e20;
    var pathCrossings: f32 = 0.0;
    for (var idx: u32 = prevEnd; idx < segEnd; idx = idx + 1u) {
      let seg = segments[idx];
      let r = dist_to_cubic(p, seg.a.xy, seg.a.zw, seg.b.xy, seg.b.zw);
      if (r.x < pathMinD) { pathMinD = r.x; }
      pathCrossings = pathCrossings + r.y;
    }
    var pathSigned: f32;
    if (pathMode(p_i) == 1u) {
      pathSigned = pathMinD - pathHalfW(p_i);
    } else {
      let insidePath = (i32(pathCrossings) % 2) == 1;
      pathSigned = select(pathMinD, -pathMinD, insidePath);
    }
    if (pathSigned < result) {
      result = pathSigned;
      winningPathIdx = p_i;
    }
    prevEnd = segEnd;
  }
  if (bake.outputMode == 1u) {
    return vec4<f32>(f32(winningPathIdx) / 15.0, 0.0, 0.0, 1.0);
  }
  return vec4<f32>(result, 0.0, 0.0, 1.0);
}
`;

/**
 * WGSL forbids dynamic-index access to resource bindings, so dispatching
 * a runtime path index to the right SDF texture means an unrolled if-
 * chain — same pattern as the GLSL shader. Generate both the binding
 * declarations and the dispatch body from MAX_PATHS so we don't have to
 * hand-maintain them.
 *
 * Textures bind starting at @binding(2) so @binding(0) can stay on the
 * uniform buffer and @binding(1) on the sampler (matching the original
 * 4-path layout). Backdrop, when present, binds immediately past them.
 */
const SDF_BINDING_START = 2;
const SDF_TEXTURE_BINDINGS = Array.from({ length: MAX_PATHS }, (_, i) =>
  `@group(0) @binding(${SDF_BINDING_START + i}) var tex${i}: texture_2d<f32>;`,
).join('\n');

export const WEBGPU_BACKDROP_BINDING = SDF_BINDING_START + MAX_PATHS;

const SAMPLE_SDF_DISPATCH = Array.from({ length: MAX_PATHS }, (_, i) =>
  `  if (i == ${i}u) { return textureSample(tex${i}, samp, t).r; }`,
).join('\n');

/**
 * Sample shader. 16 texture bindings because WGSL doesn't let us index
 * a resource binding at runtime on all platforms; unused slots still
 * get bound (to a 1x1 dummy) but `pathCount` gates the composition loop.
 *
 * Two composition modes, selected by `compositeMode`:
 *   0 — legacy: smooth-union all paths, paint in `color`. Used by the
 *       reveal example so split sub-paths morph as one shape.
 *   1 — per-path: composite fill/stroke layers per path in document
 *       order ("over" operator) at rest, so arbitrary user SVGs render
 *       with correct per-path paint. Under active cursor/ripple effects,
 *       the fills of all paths are additionally smin-fused with
 *       polynomial smooth-min and their colors blend via the same
 *       mix-weight; the blend ramps in with `effectsField` so fusion is
 *       localized to the distorted region and the at-rest result is
 *       unchanged. Strokes don't participate in the color-blend (their
 *       per-path half-width makes cross-path sausage-SDF smin
 *       ill-defined); they composite "over" the blended fill unchanged.
 */
export const WEBGPU_SAMPLE_SHADER = /* wgsl */ `
struct Uniforms {
  resolution: vec2<f32>,
  zoom: f32,
  sminK: f32,
  offset: vec2<f32>,
  compositeMode: u32,
  pathCount: u32,
  color: vec3<f32>,
  opacity: f32,
  bound: f32,
  _pad0: f32,
  cursor: vec2<f32>,
  cursorPull: f32,
  cursorRadius: f32,
  _padR: vec2<f32>,
  ripples: array<vec4<f32>, 4>,
  // Scalar-per-path values packed four-wide to satisfy WGSL's 16-byte
  // uniform-array stride; pathXyz[i / 4][i % 4] is the per-path value.
  pathMode: array<vec4<u32>, ${PATH_V4}>,
  pathStrokeHalfW: array<vec4<f32>, ${PATH_V4}>,
  pathFillOpacity: array<vec4<f32>, ${PATH_V4}>,
  pathStrokeOpacity: array<vec4<f32>, ${PATH_V4}>,
  // Colors padded to vec4 (.rgb used, .a ignored) — vec3 arrays need
  // stride 16 anyway, so padding explicitly keeps the JS writer honest.
  pathFillColor: array<vec4<f32>, ${MAX_PATHS}>,
  pathStrokeColor: array<vec4<f32>, ${MAX_PATHS}>,
  // Two vec2 per vec4: pathOffsets[i >> 1].xy for even i, .zw for odd.
  pathOffsets: array<vec4<f32>, ${MAX_PATHS / 2}>,
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var samp: sampler;
${SDF_TEXTURE_BINDINGS}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var out: VsOut;
  out.pos = vec4<f32>(pos[vi], 0.0, 1.0);
  return out;
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// Polynomial smooth-min — iquilezles.org/articles/smin. Returns
// (smin_value, h) where 'h' is the cubic mix-weight *toward 'a'*: h → 1
// when 'a' is much smaller (a dominates), h → 0 when 'b' is much
// smaller. Callers use the same h to blend per-path colors with
// mix(color_b, color_a, h). As k → 0 the h factor clamps to 0/1 and
// the -h*(1-h)*k bump vanishes, so this degenerates cleanly to min()
// and hard color selection. 'k' must be strictly positive.
fn sminPoly(a: f32, b: f32, k: f32) -> vec2<f32> {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  let d = mix(b, a, h) - h * (1.0 - h) * k;
  return vec2<f32>(d, h);
}

// Coupling between the per-pixel effects field and the local smin
// strength used for color-blend fusion in per-path composite mode.
// At rest 'effectsField = 0' so 'localK = 0' and the blend path
// contributes nothing.
const SMIN_COUPLING: f32 = 0.3;
// Width of the transition band between pure Porter-Duff (rest) and
// the full smin-blend result (active effects).
const BLEND_EPS: f32 = 0.002;

fn pathOffset(i: u32) -> vec2<f32> {
  let v = U.pathOffsets[i / 2u];
  return select(v.zw, v.xy, (i & 1u) == 0u);
}

fn sampleIdx(i: u32, uv: vec2<f32>) -> f32 {
  let po = pathOffset(i);
  let local = uv - po;
  let t = clamp((local / U.bound) * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
${SAMPLE_SDF_DISPATCH}
  return 0.0;
}

// Total subtractive deformation field at uv — cursor pull (Gaussian)
// plus any active ripple rings. See the GLSL shader's effectsField for
// the full fill-vs-stroke rationale; in short, call sites subtract this
// from the scene SDF for fills and from the sausage SDF
// (abs(d) - halfW) for strokes, which is itself a proper fill SDF.
fn effectsField(uv: vec2<f32>) -> f32 {
  let delta = uv - U.cursor;
  let r2 = dot(delta, delta);
  let sigma = max(U.cursorRadius, 1e-4);
  var total = U.cursorPull * exp(-r2 / (2.0 * sigma * sigma));
  let RIPPLE_WIDTH: f32 = 0.12;
  for (var i: i32 = 0; i < 4; i = i + 1) {
    let r = U.ripples[i];
    let rd = length(uv - r.xy);
    let rp = (rd - r.z) / RIPPLE_WIDTH;
    total = total + r.w * exp(-rp * rp);
  }
  return total;
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let res = U.resolution;
  var uv = (fragCoord.xy - 0.5 * res) / min(res.x, res.y);
  uv.y = -uv.y;
  uv = uv * (2.0 / U.zoom);
  uv = uv - U.offset;

  let field = effectsField(uv);

  if (U.compositeMode == 0u) {
    // Legacy single-color smin. Effective k is boosted locally by the
    // effects field — at rest 'k = U.sminK'; under cursor/ripple the
    // extra term strengthens fusion only where the distortion reaches,
    // so adjacent subpaths visibly bridge instead of each rippling
    // independently. Output stays single-color (legacy silhouette paints
    // 'U.color'); color-blend fusion is a per-path-mode feature.
    let k = max(U.sminK + field * SMIN_COUPLING, 1e-4);
    var d = sampleIdx(0u, uv);
    for (var i: u32 = 1u; i < ${MAX_PATHS}u; i = i + 1u) {
      if (i >= U.pathCount) { break; }
      d = smin(d, sampleIdx(i, uv), k);
    }
    d = d - field;
    let aa = fwidth(d) * 1.2;
    let mask = 1.0 - smoothstep(-aa, aa, d);
    return vec4<f32>(U.color, mask * U.opacity);
  }

  // Per-path composite. Two results are computed and blended by
  // 'blendWeight', a smoothstep of 'localK = field * SMIN_COUPLING':
  //   (A) Porter-Duff "over" across independent distorted paths — used
  //       at rest so per-path paint and document-order overlaps match
  //       the SVG exactly.
  //   (B) Smin + color-blend across fills, strokes composited "over"
  //       on top — used under active effects so adjacent subpaths fuse
  //       with smooth color gradients through the bridge.
  let localK = field * SMIN_COUPLING;
  let blendWeight = smoothstep(0.0, 2.0 * BLEND_EPS, localK);

  // (A) Porter-Duff "over" — stable per-path composite.
  var overAcc = vec4<f32>(0.0);
  for (var i: u32 = 0u; i < ${MAX_PATHS}u; i = i + 1u) {
    if (i >= U.pathCount) { break; }
    let d = sampleIdx(i, uv);
    let slot = i / 4u;
    let sub = i % 4u;
    let mode = U.pathMode[slot][sub];
    let fillOp = U.pathFillOpacity[slot][sub];
    let strokeOp = U.pathStrokeOpacity[slot][sub];
    let halfW = U.pathStrokeHalfW[slot][sub];
    if (mode != 1u) {
      let dFill = d - field;
      let aa = fwidth(dFill) * 1.2;
      let a = (1.0 - smoothstep(-aa, aa, dFill)) * fillOp;
      let src = vec4<f32>(U.pathFillColor[i].rgb * a, a);
      overAcc = src + overAcc * (1.0 - src.a);
    }
    if (mode != 0u) {
      let de = abs(d) - halfW - field;
      let aaS = fwidth(de) * 1.2;
      let a = (1.0 - smoothstep(-aaS, aaS, de)) * strokeOp;
      let src = vec4<f32>(U.pathStrokeColor[i].rgb * a, a);
      overAcc = src + overAcc * (1.0 - src.a);
    }
  }

  // (B) Smin + color-blend across fills. Always computed (not gated on
  // blendWeight) — WGSL's uniformity analyzer flags textureSample inside
  // a branch whose predicate is per-fragment (blendWeight depends on
  // fragCoord via effectsField), so we run it unconditionally. Cost is
  // two extra MAX_PATHS-bounded loops per fragment; when blendWeight = 0
  // the mix below discards the result so visual behaviour is identical.
  let kK = max(localK, 1e-4);
  var hasFill = false;
  var accSdf: f32 = 0.0;
  var accCol = vec3<f32>(0.0);
  var accOp: f32 = 0.0;
  for (var i: u32 = 0u; i < ${MAX_PATHS}u; i = i + 1u) {
    if (i >= U.pathCount) { break; }
    let slot = i / 4u;
    let sub = i % 4u;
    let mode = U.pathMode[slot][sub];
    if (mode != 1u) {
      let d = sampleIdx(i, uv);
      let fillOp = U.pathFillOpacity[slot][sub];
      let col = U.pathFillColor[i].rgb;
      if (!hasFill) {
        accSdf = d;
        accCol = col;
        accOp = fillOp;
        hasFill = true;
      } else {
        let sh = sminPoly(accSdf, d, kK);
        accCol = mix(col, accCol, sh.y);
        accOp = mix(fillOp, accOp, sh.y);
        accSdf = sh.x;
      }
    }
  }
  var blendAcc = vec4<f32>(0.0);
  if (hasFill) {
    let dFill = accSdf - field;
    let aa = fwidth(dFill) * 1.2;
    let a = (1.0 - smoothstep(-aa, aa, dFill)) * accOp;
    blendAcc = vec4<f32>(accCol * a, a);
  }
  for (var i: u32 = 0u; i < ${MAX_PATHS}u; i = i + 1u) {
    if (i >= U.pathCount) { break; }
    let slot = i / 4u;
    let sub = i % 4u;
    let mode = U.pathMode[slot][sub];
    if (mode != 0u) {
      let d = sampleIdx(i, uv);
      let strokeOp = U.pathStrokeOpacity[slot][sub];
      let halfW = U.pathStrokeHalfW[slot][sub];
      let de = abs(d) - halfW - field;
      let aaS = fwidth(de) * 1.2;
      let a = (1.0 - smoothstep(-aaS, aaS, de)) * strokeOp;
      let src = vec4<f32>(U.pathStrokeColor[i].rgb * a, a);
      blendAcc = src + blendAcc * (1.0 - src.a);
    }
  }

  let acc = mix(overAcc, blendAcc, blendWeight);
  var rgb = vec3<f32>(0.0);
  if (acc.a > 1e-6) { rgb = acc.rgb / acc.a; }
  return vec4<f32>(rgb, acc.a * U.opacity);
}
`;

const GLASS_SDF_DISPATCH = Array.from({ length: MAX_PATHS }, (_, i) =>
  `  if (i == ${i}u) { return textureSample(tex${i}, samp, t).r; }`,
).join('\n');

/**
 * Binding for the dynamic-SDF "shape B" texture. Sits one past the
 * backdrop. When the renderer is init'd in plain glass mode, this slot
 * holds a 1×1 dummy and the shader never samples it (gated by
 * `dynamicSdf`). When the renderer is init'd in glass+morph mode, slot
 * 2 holds shape A's combined SDF and this slot holds shape B's; the
 * shader's `sampleSdf` blends them by `blendT`.
 */
export const WEBGPU_DYNAMIC_SDF_B_BINDING = WEBGPU_BACKDROP_BINDING + 1;

/**
 * Path-index texture bindings for glass+morph. Same idea as the morph
 * shader's pathIdxA/B — each side's per-pixel "winning path" map. In
 * plain glass mode these slots hold the 1×1 dummy and the shader never
 * samples them (`dynamicSdf == 0`).
 */
export const WEBGPU_PATH_IDX_A_BINDING = WEBGPU_DYNAMIC_SDF_B_BINDING + 1;
export const WEBGPU_PATH_IDX_B_BINDING = WEBGPU_DYNAMIC_SDF_B_BINDING + 2;
/** Nearest-filter sampler binding for the glass shader's path-index
 *  lookups. Same rationale as the morph shader's sampNearest. */
export const WEBGPU_GLASS_NEAREST_SAMPLER_BINDING = WEBGPU_DYNAMIC_SDF_B_BINDING + 3;

/**
 * Liquid-glass sample pipeline. Same shape-compositing as the legacy
 * smin branch — all paths smooth-unioned into one silhouette — but uses
 * the combined SDF's screen-space gradient as a surface normal to
 * refract a backdrop texture through the shape. See the GLSL mirror in
 * shaders/webgl.ts for the full rationale of each ingredient.
 *
 * Bindings:
 *   0: uniforms (GlassUniforms)
 *   1: sampler (linear, clamp — shared by SDF and backdrop)
 *   2..${SDF_BINDING_START + MAX_PATHS - 1}: baked SDF textures (texN)
 *   ${WEBGPU_BACKDROP_BINDING}: backdrop texture
 *   ${WEBGPU_BACKDROP_BINDING + 1}: dynamic-SDF "shape B" texture
 */
export const WEBGPU_GLASS_SHADER = /* wgsl */ `
struct GlassUniforms {
  resolution: vec2<f32>,
  zoom: f32,
  sminK: f32,
  offset: vec2<f32>,
  pathCount: u32,
  opacity: f32,
  refractionStrength: f32,
  chromaticStrength: f32,
  fresnelStrength: f32,
  tintStrength: f32,
  rimColor: vec3<f32>,
  bound: f32,
  tintColor: vec3<f32>,
  frostStrength: f32,
  cursor: vec2<f32>,
  cursorPull: f32,
  cursorRadius: f32,
  ripples: array<vec4<f32>, 4>,
  // Per-path render mode (0=fill, 1=stroke, 2=both) and stroke half-width.
  // Mirrors the sample pipeline so strokes render as glass sausages
  // (abs(d) - halfW, a proper 2D fill SDF) instead of solid silhouettes.
  // For mode 2 ("both"), glass treats the path as a fill — the filled
  // silhouette is what the lens refracts through; a stroke on top of
  // glass rarely reads visually. Scalars packed four-wide to satisfy
  // WGSL's 16-byte uniform-array stride.
  pathMode: array<vec4<u32>, ${PATH_V4}>,
  pathStrokeHalfW: array<vec4<f32>, ${PATH_V4}>,
  // Two vec2 per vec4, indexed via pathOffset() helper below.
  pathOffsets: array<vec4<f32>, ${MAX_PATHS / 2}>,
  // Dynamic-SDF mode: when 'dynamicSdf' is non-zero the lens SDF at
  // each pixel is mix(sample(tex0), sample(sdfB), blendT) — used for
  // glass-on-morph composition (and any future effect that wants a
  // blended-SDF source). See WEBGL_GLASS_FRAG for the full rationale.
  //
  // In dynamic-SDF mode, the tint that's normally driven by the single
  // 'tintColor' uniform becomes per-pixel: sample each side's path-
  // index map, look up 'pathColorsA/B' for that path index, and lerp
  // by blendT. 'useOverrideA/B' falls back to 'morphColorA/B' (a flat
  // single-color override per side, used when the React 'color' /
  // 'toColor' props are set).
  dynamicSdf: u32,
  blendT: f32,
  useOverrideA: u32,
  useOverrideB: u32,
  morphColorA: vec3<f32>,
  _padA: f32,
  morphColorB: vec3<f32>,
  _padB: f32,
  pathColorsA: array<vec4<f32>, ${MAX_PATHS}>,
  pathColorsB: array<vec4<f32>, ${MAX_PATHS}>,
};

@group(0) @binding(0) var<uniform> U: GlassUniforms;
@group(0) @binding(1) var samp: sampler;
${SDF_TEXTURE_BINDINGS}
@group(0) @binding(${WEBGPU_BACKDROP_BINDING}) var backdrop: texture_2d<f32>;
@group(0) @binding(${WEBGPU_BACKDROP_BINDING + 1}) var sdfB: texture_2d<f32>;
@group(0) @binding(${WEBGPU_PATH_IDX_A_BINDING}) var pathIdxA: texture_2d<f32>;
@group(0) @binding(${WEBGPU_PATH_IDX_B_BINDING}) var pathIdxB: texture_2d<f32>;
@group(0) @binding(${WEBGPU_GLASS_NEAREST_SAMPLER_BINDING}) var sampNearest: sampler;

fn decodePathIdx(v: f32) -> u32 {
  let raw = u32(round(clamp(v, 0.0, 1.0) * 15.0));
  return min(raw, ${MAX_PATHS - 1}u);
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var out: VsOut;
  out.pos = vec4<f32>(pos[vi], 0.0, 1.0);
  return out;
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

fn pathOffset(i: u32) -> vec2<f32> {
  let v = U.pathOffsets[i / 2u];
  return select(v.zw, v.xy, (i & 1u) == 0u);
}

fn sampleSdf(i: u32, uv: vec2<f32>) -> f32 {
  let po = pathOffset(i);
  let local = uv - po;
  let t = clamp((local / U.bound) * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
${GLASS_SDF_DISPATCH}
  return 0.0;
}

// Coupling between the effects field and the local smin strength used
// for cross-path fusion in glass. Added to 'U.sminK' so the at-rest
// fusion baseline is preserved and the cursor region gets a stronger
// bridge on top. Tune down specifically for glass if strong cursor
// pulls over-fuse.
const GLASS_SMIN_COUPLING: f32 = 0.3;

// Converts a raw per-path SDF to the right fill-SDF for glass rendering:
//   - fill (0) or both (2): the scene SDF as-is
//   - stroke (1):           abs(d) - halfW, the SDF of the curve dilated
//                           by halfW, i.e. the "sausage" region — itself a
//                           proper 2D fill SDF, so all the glass math
//                           (height field, normals, refraction, Fresnel)
//                           works on it unchanged.
// Then smooth-unions across all active paths with the caller-supplied
// 'k'. Caller injects 'U.sminK + localK' so fusion strengthens under
// the cursor (see 'lens' below).
fn shapeSdf(uv: vec2<f32>, kIn: f32) -> f32 {
  let k = max(kIn, 1e-4);
  let d0 = sampleSdf(0u, uv);
  let m0 = U.pathMode[0][0];
  let h0 = U.pathStrokeHalfW[0][0];
  var d = select(d0, abs(d0) - h0, m0 == 1u);
  for (var i: u32 = 1u; i < ${MAX_PATHS}u; i = i + 1u) {
    if (i >= U.pathCount) { break; }
    let di = sampleSdf(i, uv);
    let mi = U.pathMode[i / 4u][i % 4u];
    let hi = U.pathStrokeHalfW[i / 4u][i % 4u];
    let ci = select(di, abs(di) - hi, mi == 1u);
    d = smin(d, ci, k);
  }
  return d;
}

// Mirror of the sample shader's effectsField. Lets the glass material
// compose with cursor pull + ripple deformations by subtracting this
// field from the lens SDF wherever it's evaluated (silhouette pass and
// each height-field tap).
fn effectsField(uv: vec2<f32>) -> f32 {
  let delta = uv - U.cursor;
  let r2 = dot(delta, delta);
  let sigma = max(U.cursorRadius, 1e-4);
  var total = U.cursorPull * exp(-r2 / (2.0 * sigma * sigma));
  let RIPPLE_WIDTH: f32 = 0.12;
  for (var i: i32 = 0; i < 4; i = i + 1) {
    let r = U.ripples[i];
    let rd = length(uv - r.xy);
    let rp = (rd - r.z) / RIPPLE_WIDTH;
    total = total + r.w * exp(-rp * rp);
  }
  return total;
}

// Combined lens SDF at 'uv'. Two source modes selected by 'U.dynamicSdf':
//   - 0: cross-path smin silhouette (with local k boosted by the effects
//     field) — existing glass behaviour.
//   - 1: per-fragment lerp 'mix(dA, dB, U.blendT)' over two combined
//     SDFs sampled from tex0 (shape A) and sdfB (shape B). Skips smin
//     because each side was already flattened-and-baked into a single
//     proper fill SDF by the morph pipeline.
// In both modes the same effects field is subtracted, so cursor and
// ripple deformations compose with whichever SDF source drives the lens.
fn lens(uv: vec2<f32>) -> f32 {
  let f = effectsField(uv);
  if (U.dynamicSdf != 0u) {
    let st = clamp((uv / U.bound) * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
    let dA = textureSample(tex0, samp, st).r;
    let dB = textureSample(sdfB, samp, st).r;
    return mix(dA, dB, U.blendT) - f;
  }
  return shapeSdf(uv, U.sminK + f * GLASS_SMIN_COUPLING) - f;
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let res = U.resolution;
  var uv = (fragCoord.xy - 0.5 * res) / min(res.x, res.y);
  uv.y = -uv.y;
  uv = uv * (2.0 / U.zoom);
  uv = uv - U.offset;

  let d = lens(uv);
  let aa = fwidth(d) * 1.2;
  let insideMask = 1.0 - smoothstep(-aa, aa, d);

  // See the GLSL mirror for the full rationale: any height field that's
  // a function of the SDF has a zero-gradient plateau along the shape's
  // medial axis, which reads as hard refraction facets. The fix is to
  // build the height field from a *blurred indicator* instead — smooth
  // each SDF sample through a smoothstep to get 0-or-1 inside/outside
  // values, then average 9 samples over a radial kernel. The result is
  // a genuine smooth dome: flat plateau in the interior, smooth rising
  // rim, no medial-axis creases.
  let SDF_BLUR:  f32 = 0.08;
  let SOFT_EDGE: f32 = 0.03;
  let D:         f32 = 0.70710678 * SDF_BLUR;  // = SDF_BLUR / √2

  var h  = (1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv))) * 2.0;
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv + vec2<f32>(SDF_BLUR, 0.0)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv - vec2<f32>(SDF_BLUR, 0.0)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv + vec2<f32>(0.0, SDF_BLUR)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv - vec2<f32>(0.0, SDF_BLUR)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv + vec2<f32>( D,  D)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv + vec2<f32>( D, -D)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv + vec2<f32>(-D,  D)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv + vec2<f32>(-D, -D)));
  h = h / 10.0;

  let grad = vec2<f32>(dpdx(h), dpdy(h));
  let gradMag = length(grad);
  let normal = grad / max(gradMag, 1e-6);

  // Lens intensity falls out of the smoothed height: 1 at the rim
  // (h ≈ 0.5), 0 in the interior (h = 1). Doubled so the rim peak
  // normalises to 1.
  let lensAmount = clamp((1.0 - h) * 2.0, 0.0, 1.0);

  // Interior proxy for tint and frost — derived from h so bands follow
  // the smoothed height field rather than the SDF iso-contours, which
  // would otherwise paint medial-axis cusps into the tint.
  let interior = smoothstep(0.5, 1.0, h);

  let sdfToUv = vec2<f32>(min(res.x, res.y)) / res;
  let refractOffset = normal * h * (1.0 - h) * lensAmount * U.refractionStrength * sdfToUv;

  let backdropUv = fragCoord.xy / res;
  let offR = backdropUv + refractOffset * (1.0 - U.chromaticStrength);
  let offG = backdropUv + refractOffset;
  let offB = backdropUv + refractOffset * (1.0 + U.chromaticStrength);

  // Chromatic sample at the G offset returns rgb (center of the frost
  // kernel too, so we don't re-fetch it). R and B channels get their
  // own offset samples to produce the fringe.
  let gRgb = textureSample(backdrop, samp, offG).rgb;
  let rCh  = textureSample(backdrop, samp, offR).r;
  let bCh  = textureSample(backdrop, samp, offB).b;
  let chromaticColor = vec3<f32>(rCh, gRgb.g, bCh);

  // 5-tap cross-blur frost, radius scaled by interior depth. Gives the
  // "slightly frosted window" quality across the middle of the lens;
  // at the rim the radius is near zero so chromatic refraction still
  // reads sharply. Sampled unconditionally — a branch here would take
  // textureSample out of uniform control flow and derivatives would
  // go undefined.
  let frostPx = U.frostStrength * interior;
  let fs = vec2<f32>(frostPx) / res;
  var frost = gRgb;
  frost = frost + textureSample(backdrop, samp, offG + vec2<f32>(fs.x, 0.0)).rgb;
  frost = frost + textureSample(backdrop, samp, offG - vec2<f32>(fs.x, 0.0)).rgb;
  frost = frost + textureSample(backdrop, samp, offG + vec2<f32>(0.0, fs.y)).rgb;
  frost = frost + textureSample(backdrop, samp, offG - vec2<f32>(0.0, fs.y)).rgb;
  frost = frost * 0.2;

  var color = mix(frost, chromaticColor, lensAmount);

  let rim = smoothstep(-0.03, -0.005, d) * (1.0 - smoothstep(-0.005, 0.0, d));
  color = color + U.rimColor * rim * U.fresnelStrength;

  // Interior tint. In glass+morph (dynamic-SDF) mode the tint is per-
  // pixel — sample each side's path-index map, look up that path's
  // color, lerp by blendT. Override flags fall back to a flat color
  // per side (or the single-tint material when both are unset). Plain
  // glass mode preserves the existing single-color tint.
  var tintColor: vec3<f32>;
  if (U.dynamicSdf != 0u) {
    let st = clamp((uv / U.bound) * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
    var tA: vec3<f32>;
    if (U.useOverrideA != 0u) {
      tA = U.morphColorA;
    } else {
      let idxA = decodePathIdx(textureSample(pathIdxA, sampNearest, st).r);
      tA = U.pathColorsA[idxA].rgb;
    }
    var tB: vec3<f32>;
    if (U.useOverrideB != 0u) {
      tB = U.morphColorB;
    } else {
      let idxB = decodePathIdx(textureSample(pathIdxB, sampNearest, st).r);
      tB = U.pathColorsB[idxB].rgb;
    }
    tintColor = mix(tA, tB, U.blendT);
  } else {
    tintColor = U.tintColor;
  }
  color = mix(color, tintColor, clamp(interior * U.tintStrength, 0.0, 1.0));

  return vec4<f32>(color, insideMask * U.opacity);
  //return vec4<f32>(normal * 0.5 + 0.5, 0.0, insideMask);
}
`;

/**
 * Morph sample shader — flatten-then-bake architecture. One combined
 * SDF per side (texA, texB) lerped by `morphT` produces the unified
 * silhouette; the bake's fill-rule-aware combine (see WEBGPU_BAKE_SHADER's
 * sceneSDF for the fill-rule semantics) is what unifies multi-subpath
 * inputs into one coherent shape.
 *
 * Per-path colors. Each side also carries a path-index texture (baked
 * by the same shader with `outputMode == 1`) recording which sub-path
 * "won" the union at that pixel. The renderer uploads each side's per-
 * path RGB colors into `U.pathColorsA / pathColorsB`; the shader looks
 * up the corresponding entry and lerps A→B by `U.morphT`. Result: the
 * morphing silhouette preserves each region's intrinsic SVG color
 * through the transition (sharp boundaries within a single shape are
 * intentional — match how SVG natively renders).
 *
 * `useOverrideA/B` collapses to a single-color paint (`colorA/colorB`)
 * when the caller supplies an explicit color override; mixed modes
 * (override one side, per-path the other) work too.
 *
 * Bindings:
 *   0: uniforms (MorphUniforms)
 *   1: sampler (linear, clamp)
 *   2: texA            (shape A combined SDF)
 *   3: texB            (shape B combined SDF)
 *   4: pathIdxA        (shape A path-index map)
 *   5: pathIdxB        (shape B path-index map)
 */
export const WEBGPU_MORPH_SDF_A_BINDING = 2;
export const WEBGPU_MORPH_SDF_B_BINDING = 3;
export const WEBGPU_MORPH_PATH_IDX_A_BINDING = 4;
export const WEBGPU_MORPH_PATH_IDX_B_BINDING = 5;
/** Dedicated nearest-filter sampler used by the path-index lookups in
 *  the morph shader. See the WGSL comment by the binding declaration. */
export const WEBGPU_MORPH_NEAREST_SAMPLER_BINDING = 6;

export const WEBGPU_MORPH_SHADER = /* wgsl */ `
struct MorphUniforms {
  resolution: vec2<f32>,
  zoom: f32,
  morphT: f32,
  offset: vec2<f32>,
  opacity: f32,
  bound: f32,
  colorA: vec3<f32>,
  useOverrideA: u32,
  colorB: vec3<f32>,
  useOverrideB: u32,
  pathColorsA: array<vec4<f32>, ${MAX_PATHS}>,
  pathColorsB: array<vec4<f32>, ${MAX_PATHS}>,
};

@group(0) @binding(0) var<uniform> U: MorphUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(${WEBGPU_MORPH_SDF_A_BINDING}) var sdfA: texture_2d<f32>;
@group(0) @binding(${WEBGPU_MORPH_SDF_B_BINDING}) var sdfB: texture_2d<f32>;
@group(0) @binding(${WEBGPU_MORPH_PATH_IDX_A_BINDING}) var pathIdxA: texture_2d<f32>;
@group(0) @binding(${WEBGPU_MORPH_PATH_IDX_B_BINDING}) var pathIdxB: texture_2d<f32>;
// Nearest sampler dedicated to the path-index lookups. Linear filtering
// would blend integer-encoded path indices at region boundaries (e.g.
// indices 3 and 7 on either side of an edge would produce a sample at
// 5/15 — pointing into a third region's colors). NEAREST guarantees
// each fragment reads exactly one texel's encoded index.
@group(0) @binding(${WEBGPU_MORPH_NEAREST_SAMPLER_BINDING}) var sampNearest: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var out: VsOut;
  out.pos = vec4<f32>(pos[vi], 0.0, 1.0);
  return out;
}

// Decode the [0..15]/15 path-index encoding the bake writes back into a
// u32. Half-float storage is plenty for 16 buckets; clamp to MAX_PATHS-1
// in case sampling lands fractionally above 15/15 from filter edges.
fn decodePathIdx(v: f32) -> u32 {
  let raw = u32(round(clamp(v, 0.0, 1.0) * 15.0));
  return min(raw, ${MAX_PATHS - 1}u);
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let res = U.resolution;
  var uv = (fragCoord.xy - 0.5 * res) / min(res.x, res.y);
  uv.y = -uv.y;
  uv = uv * (2.0 / U.zoom);
  uv = uv - U.offset;

  let st = clamp((uv / U.bound) * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
  let dA = textureSample(sdfA, samp, st).r;
  let dB = textureSample(sdfB, samp, st).r;
  let d = mix(dA, dB, U.morphT);
  let aa = fwidth(d) * 1.2;
  let mask = 1.0 - smoothstep(-aa, aa, d);

  // Per-side color resolution. Override ⇒ flat color; otherwise sample
  // the path-index map and look up the per-path color. WGSL allows
  // dynamic indexing of uniform arrays directly so no unrolling needed.
  var colorA: vec3<f32>;
  if (U.useOverrideA != 0u) {
    colorA = U.colorA;
  } else {
    let idxA = decodePathIdx(textureSample(pathIdxA, sampNearest, st).r);
    colorA = U.pathColorsA[idxA].rgb;
  }
  var colorB: vec3<f32>;
  if (U.useOverrideB != 0u) {
    colorB = U.colorB;
  } else {
    let idxB = decodePathIdx(textureSample(pathIdxB, sampNearest, st).r);
    colorB = U.pathColorsB[idxB].rgb;
  }
  let color = mix(colorA, colorB, U.morphT);
  return vec4<f32>(color, mask * U.opacity);
}
`;
