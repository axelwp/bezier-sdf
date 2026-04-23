/**
 * WGSL shaders for the WebGPU renderer. Same algorithm as the GLSL
 * version — bake SDFs per path, then sample + either smooth-union
 * (legacy single-color mode used by the reveal example) or composite
 * per-path fill/stroke layers (used for arbitrary user SVGs).
 */

export const WEBGPU_BAKE_SIZE = 1024;
export const WEBGPU_BAKE_BOUND = 1.2;

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

fn applyDistEffects(d0: f32, uv: vec2<f32>) -> f32 {
  var d = d0;
  let toCursor = U.cursor - uv;
  d = d - U.cursorPull / (dot(toCursor, toCursor) + U.cursorRadius);
  let RIPPLE_WIDTH: f32 = 0.12;
  for (var i: i32 = 0; i < 4; i = i + 1) {
    let r = U.ripples[i];
    let rd = length(uv - r.xy);
    let rp = (rd - r.z) / RIPPLE_WIDTH;
    d = d - r.w * exp(-rp * rp);
  }
  return d;
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let res = U.resolution;
  var uv = (fragCoord.xy - 0.5 * res) / min(res.x, res.y);
  uv.y = -uv.y;
  uv = uv * (2.0 / U.zoom);
  uv = uv - U.offset;

  if (U.compositeMode == 0u) {
    let k = max(U.sminK, 1e-4);
    var d = sampleIdx(0u, uv);
    if (U.pathCount > 1u) { d = smin(d, sampleIdx(1u, uv), k); }
    if (U.pathCount > 2u) { d = smin(d, sampleIdx(2u, uv), k); }
    if (U.pathCount > 3u) { d = smin(d, sampleIdx(3u, uv), k); }
    d = applyDistEffects(d, uv);
    let aa = fwidth(d) * 1.2;
    let mask = 1.0 - smoothstep(-aa, aa, d);
    return vec4<f32>(U.color, mask * U.opacity);
  }

  // Per-path composite: accumulate with Porter-Duff "over" in premultiplied
  // alpha, convert back to straight alpha at the end.
  var acc = vec4<f32>(0.0);
  for (var i: u32 = 0u; i < 4u; i = i + 1u) {
    if (i >= U.pathCount) { break; }
    var d = sampleIdx(i, uv);
    d = applyDistEffects(d, uv);
    let mode = U.pathMode[i];
    let aa = fwidth(d) * 1.2;

    // Fill layer (mode 0 or 2).
    if (mode != 1u) {
      let a = (1.0 - smoothstep(-aa, aa, d)) * U.pathFillOpacity[i];
      let src = vec4<f32>(U.pathFillColor[i].rgb * a, a);
      acc = src + acc * (1.0 - src.a);
    }
    // Stroke layer (mode 1 or 2).
    if (mode != 0u) {
      let halfW = U.pathStrokeHalfW[i];
      let de = abs(d) - halfW;
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
