/**
 * WGSL shaders for the WebGPU renderer. Same algorithm as the GLSL
 * version — bake SDFs per path, then sample + smooth-union at runtime.
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
 * slots are still bound (to a 1x1 dummy) but u_pathCount gates the
 * smooth-union loop.
 */
export const WEBGPU_SAMPLE_SHADER = /* wgsl */ `
struct Uniforms {
  resolution: vec2<f32>,
  zoom: f32,
  sminK: f32,
  offset: vec2<f32>,
  _pad0: vec2<f32>,
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
  _padR: vec2<f32>,             // explicit pad — array<vec4> needs 16-byte align
  ripples: array<vec4<f32>, 4>, // (x, y, age, amplitude) per slot
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

fn sampleAt(tex: texture_2d<f32>, uv: vec2<f32>, pathOffset: vec2<f32>) -> f32 {
  let local = uv - pathOffset;
  let t = clamp((local / U.bound) * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
  return textureSample(tex, samp, t).r;
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let res = U.resolution;
  var uv = (fragCoord.xy - 0.5 * res) / min(res.x, res.y);
  uv.y = -uv.y;
  uv = uv * (2.0 / U.zoom);
  uv = uv - U.offset;

  let k = max(U.sminK, 1e-4);
  var d = sampleAt(tex0, uv, U.pathOffset0);
  if (U.pathCount > 1u) { d = smin(d, sampleAt(tex1, uv, U.pathOffset1), k); }
  if (U.pathCount > 2u) { d = smin(d, sampleAt(tex2, uv, U.pathOffset2), k); }
  if (U.pathCount > 3u) { d = smin(d, sampleAt(tex3, uv, U.pathOffset3), k); }

  // Liquid-cursor pull — subtract an inverse-square radial field from the
  // scene SDF. Locally reduces the distance value, so the zero-contour
  // (the silhouette edge) bulges out toward the cursor and fuses with it
  // when close. cursorPull=0 disables; cursorRadius is a softening
  // epsilon (smaller = sharper/narrower tendril).
  let toCursor = U.cursor - uv;
  d = d - U.cursorPull / (dot(toCursor, toCursor) + U.cursorRadius);

  // Up to 4 concurrent shockwave rings. JS advances each ring's radius
  // (ripples[i].z) and tapers its amplitude (ripples[i].w) independently.
  // Dead slots (amplitude=0) contribute nothing.
  let RIPPLE_WIDTH: f32 = 0.12;
  for (var i: i32 = 0; i < 4; i = i + 1) {
    let r = U.ripples[i];
    let rd = length(uv - r.xy);
    let rp = (rd - r.z) / RIPPLE_WIDTH;
    d = d - r.w * exp(-rp * rp);
  }

  let aa = fwidth(d) * 1.2;
  let mask = 1.0 - smoothstep(-aa, aa, d);
  return vec4<f32>(U.color, mask * U.opacity);
}
`;
