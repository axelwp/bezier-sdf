/**
 * WGSL shaders for the WebGPU renderer. Same algorithm as the GLSL
 * version — bake SDFs per path, then sample + either smooth-union
 * (legacy single-color mode used by the reveal example) or composite
 * per-path fill/stroke layers (used for arbitrary user SVGs).
 */

export const WEBGPU_BAKE_SIZE = 1024;
export const WEBGPU_BAKE_BOUND = 1.2;

/**
 * Uniform buffer layout for the glass sample pipeline. Tight 80-byte
 * struct; WGSL vec3 has align 16 / size 12, so `bound` gets packed into
 * the 4 bytes after `rimColor` within its 16-byte slot.
 *
 *   resolution         : vec2<f32>   // 0   (8)
 *   zoom               : f32         // 8   (4)
 *   sminK              : f32         // 12  (4)
 *   offset             : vec2<f32>   // 16  (8)
 *   pathCount          : u32         // 24  (4)
 *   opacity            : f32         // 28  (4)
 *   refractionStrength : f32         // 32  (4)
 *   chromaticStrength  : f32         // 36  (4)
 *   fresnelStrength    : f32         // 40  (4)
 *   tintStrength       : f32         // 44  (4)
 *   rimColor           : vec3<f32>   // 48  (12)
 *   bound              : f32         // 60  (4)
 *   tintColor          : vec3<f32>   // 64  (12)
 *   frostStrength      : f32         // 76  (4)
 *   cursor             : vec2<f32>   // 80  (8)
 *   cursorPull         : f32         // 88  (4)
 *   cursorRadius       : f32         // 92  (4)
 *   ripples            : array<vec4<f32>, 4> // 96 (64)
 *   pathOffset0..3     : vec2<f32>[4] // 160 (32)
 * Total: 192 bytes, 16-aligned.
 */
export const WEBGPU_GLASS_UNIFORM_SIZE = 192;

/**
 * Bake shader. A storage buffer of (P0, P1, P2, P3) cubics gets uploaded
 * per bake pass; the fragment shader walks them for each pixel of a
 * 1024x1024 r16float render target.
 */
export const WEBGPU_BAKE_SHADER = /* wgsl */ `
struct Segment {
  a: vec4<f32>, // (P0, P1)
  b: vec4<f32>, // (P2, P3)
};
struct BakeUniforms {
  bound: f32,
  _pad: vec3<f32>,
};

@group(0) @binding(0) var<storage, read> segments: array<Segment>;

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

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  // Flip Y — our geometry uses +y up, render targets use +y down.
  let p = vec2<f32>(uv.x, -uv.y);
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
  return vec4<f32>(signed_d, 0.0, 0.0, 1.0);
}
`;

/**
 * Sample shader. Fixed-count texture bindings (4) because WGSL doesn't
 * let us index sampler arrays at draw time on all platforms. Unused
 * slots are still bound (to a 1x1 dummy) but pathCount gates the
 * composition loop.
 *
 * Two composition modes, selected by `compositeMode`:
 *   0 — legacy: smooth-union all paths, paint in `color`. Used by the
 *       reveal example so split sub-paths morph as one shape.
 *   1 — per-path: composite fill/stroke layers per path in document
 *       order ("over" operator). Used for arbitrary user SVGs. smin is
 *       not applied across paths in this mode; see KNOWN_LIMITATIONS.md.
 */
export const WEBGPU_SAMPLE_SHADER = /* wgsl */ `
struct Uniforms {
  resolution: vec2<f32>,
  zoom: f32,
  sminK: f32,
  offset: vec2<f32>,
  compositeMode: u32,
  _pad0: u32,
  pathOffset0: vec2<f32>,
  pathOffset1: vec2<f32>,
  pathOffset2: vec2<f32>,
  pathOffset3: vec2<f32>,
  color: vec3<f32>,
  opacity: f32,
  bound: f32,
  pathCount: u32,
  cursor: vec2<f32>,
  cursorPull: f32,
  cursorRadius: f32,
  _padR: vec2<f32>,
  ripples: array<vec4<f32>, 4>,
  pathMode: vec4<u32>,
  pathStrokeHalfW: vec4<f32>,
  pathFillOpacity: vec4<f32>,
  pathStrokeOpacity: vec4<f32>,
  pathFillColor: array<vec4<f32>, 4>,
  pathStrokeColor: array<vec4<f32>, 4>,
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex0: texture_2d<f32>;
@group(0) @binding(3) var tex1: texture_2d<f32>;
@group(0) @binding(4) var tex2: texture_2d<f32>;
@group(0) @binding(5) var tex3: texture_2d<f32>;

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

fn sampleIdx(i: u32, uv: vec2<f32>) -> f32 {
  var po = U.pathOffset0;
  if (i == 1u) { po = U.pathOffset1; }
  else if (i == 2u) { po = U.pathOffset2; }
  else if (i == 3u) { po = U.pathOffset3; }
  let local = uv - po;
  let t = clamp((local / U.bound) * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
  if (i == 0u) { return textureSample(tex0, samp, t).r; }
  if (i == 1u) { return textureSample(tex1, samp, t).r; }
  if (i == 2u) { return textureSample(tex2, samp, t).r; }
  return textureSample(tex3, samp, t).r;
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
    let k = max(U.sminK, 1e-4);
    var d = sampleIdx(0u, uv);
    if (U.pathCount > 1u) { d = smin(d, sampleIdx(1u, uv), k); }
    if (U.pathCount > 2u) { d = smin(d, sampleIdx(2u, uv), k); }
    if (U.pathCount > 3u) { d = smin(d, sampleIdx(3u, uv), k); }
    d = d - field;
    let aa = fwidth(d) * 1.2;
    let mask = 1.0 - smoothstep(-aa, aa, d);
    return vec4<f32>(U.color, mask * U.opacity);
  }

  // Per-path composite: accumulate with Porter-Duff "over" in premultiplied
  // alpha, convert back to straight alpha at the end.
  var acc = vec4<f32>(0.0);
  for (var i: u32 = 0u; i < 4u; i = i + 1u) {
    if (i >= U.pathCount) { break; }
    let d = sampleIdx(i, uv);
    let mode = U.pathMode[i];

    // Fill layer (mode 0 or 2). Distort the scene SDF directly.
    if (mode != 1u) {
      let dFill = d - field;
      let aa = fwidth(dFill) * 1.2;
      let a = (1.0 - smoothstep(-aa, aa, dFill)) * U.pathFillOpacity[i];
      let src = vec4<f32>(U.pathFillColor[i].rgb * a, a);
      acc = src + acc * (1.0 - src.a);
    }
    // Stroke layer (mode 1 or 2). Distort the sausage SDF — the proper
    // fill SDF of the curve dilated by halfW — rather than d itself.
    if (mode != 0u) {
      let halfW = U.pathStrokeHalfW[i];
      let de = abs(d) - halfW - field;
      let aaS = fwidth(de) * 1.2;
      let a = (1.0 - smoothstep(-aaS, aaS, de)) * U.pathStrokeOpacity[i];
      let src = vec4<f32>(U.pathStrokeColor[i].rgb * a, a);
      acc = src + acc * (1.0 - src.a);
    }
  }
  var rgb = vec3<f32>(0.0);
  if (acc.a > 1e-6) { rgb = acc.rgb / acc.a; }
  return vec4<f32>(rgb, acc.a * U.opacity);
}
`;

/**
 * Liquid-glass sample pipeline. Same shape-compositing as the legacy
 * smin branch — all paths smooth-unioned into one silhouette — but uses
 * the combined SDF's screen-space gradient as a surface normal to
 * refract a backdrop texture through the shape. See the GLSL mirror in
 * shaders/webgl.ts for the full rationale of each ingredient.
 *
 * Bindings:
 *   0: uniforms (GlassUniforms, 80 bytes)
 *   1: sampler (linear, clamp — shared by SDF and backdrop)
 *   2..5: baked SDF textures (tex0..tex3)
 *   6: backdrop texture
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
  pathOffset0: vec2<f32>,
  pathOffset1: vec2<f32>,
  pathOffset2: vec2<f32>,
  pathOffset3: vec2<f32>,
};

@group(0) @binding(0) var<uniform> U: GlassUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex0: texture_2d<f32>;
@group(0) @binding(3) var tex1: texture_2d<f32>;
@group(0) @binding(4) var tex2: texture_2d<f32>;
@group(0) @binding(5) var tex3: texture_2d<f32>;
@group(0) @binding(6) var backdrop: texture_2d<f32>;

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

fn sampleSdf(i: u32, uv: vec2<f32>) -> f32 {
  var po = U.pathOffset0;
  if (i == 1u) { po = U.pathOffset1; }
  else if (i == 2u) { po = U.pathOffset2; }
  else if (i == 3u) { po = U.pathOffset3; }
  let local = uv - po;
  let t = clamp((local / U.bound) * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
  if (i == 0u) { return textureSample(tex0, samp, t).r; }
  if (i == 1u) { return textureSample(tex1, samp, t).r; }
  if (i == 2u) { return textureSample(tex2, samp, t).r; }
  return textureSample(tex3, samp, t).r;
}

fn combinedSdf(uv: vec2<f32>) -> f32 {
  let k = max(U.sminK, 1e-4);
  var d = sampleSdf(0u, uv);
  if (U.pathCount > 1u) { d = smin(d, sampleSdf(1u, uv), k); }
  if (U.pathCount > 2u) { d = smin(d, sampleSdf(2u, uv), k); }
  if (U.pathCount > 3u) { d = smin(d, sampleSdf(3u, uv), k); }
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

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let res = U.resolution;
  var uv = (fragCoord.xy - 0.5 * res) / min(res.x, res.y);
  uv.y = -uv.y;
  uv = uv * (2.0 / U.zoom);
  uv = uv - U.offset;

  let d = combinedSdf(uv) - effectsField(uv);
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

  var h  = (1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv) - effectsField(uv))) * 2.0;
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv + vec2<f32>(SDF_BLUR, 0.0)) - effectsField(uv + vec2<f32>(SDF_BLUR, 0.0)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv - vec2<f32>(SDF_BLUR, 0.0)) - effectsField(uv - vec2<f32>(SDF_BLUR, 0.0)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv + vec2<f32>(0.0, SDF_BLUR)) - effectsField(uv + vec2<f32>(0.0, SDF_BLUR)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv - vec2<f32>(0.0, SDF_BLUR)) - effectsField(uv - vec2<f32>(0.0, SDF_BLUR)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv + vec2<f32>( D,  D)) - effectsField(uv + vec2<f32>( D,  D)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv + vec2<f32>( D, -D)) - effectsField(uv + vec2<f32>( D, -D)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv + vec2<f32>(-D,  D)) - effectsField(uv + vec2<f32>(-D,  D)));
  h = h + 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv + vec2<f32>(-D, -D)) - effectsField(uv + vec2<f32>(-D, -D)));
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

  color = mix(color, U.tintColor, clamp(interior * U.tintStrength, 0.0, 1.0));

  return vec4<f32>(color, insideMask * U.opacity);
  //return vec4<f32>(normal * 0.5 + 0.5, 0.0, insideMask);
}
`;
