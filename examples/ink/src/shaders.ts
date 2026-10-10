/**
 * GLSL ES 3.00 shaders for the ink-wash example.
 *
 * Two passes, mirroring the core renderer's bake/sample split:
 *
 *   1. BAKE — evaluates the mark's signed distance straight from its cubic
 *      Beziers over [-BOUND, BOUND]² into an RGBA16F texture. R holds the
 *      signed distance (per-path even-odd parity, paths hard-unioned with
 *      min(), same rule as core's nonzero bake). G holds the "ink tone" of
 *      whichever path won the min, so each stroke can carry its own value
 *      the way a painter loads the brush differently for culm and leaves.
 *      B holds that path's brush direction (its principal axis, radians),
 *      which orients the dry-brush hair streaks.
 *
 *   2. INK — runs per frame. Paints a procedural paper, then derives every
 *      ink feature from the sampled distance:
 *        - blotching:  the lookup position is domain-warped by fbm noise,
 *                      so contours wobble like ink spreading unevenly;
 *        - wet edge:   pigment density rises exponentially toward d = 0,
 *                      the dark rim left when a wash dries from its edge;
 *        - bleed:      the effective edge is pushed outward where paper
 *                      fibres and low grain wick ink, with a faint halo;
 *        - dry brush:  hair streaks running along each stroke's brush
 *                      direction, plus paper tooth, knock holes in the ink
 *                      where a low-frequency "brush running dry" mask is
 *                      high;
 *        - granulation: pigment settles into the paper's valleys.
 *
 * Noise lives in paper space, so the texture of the paper and the way it
 * takes ink stay put while the geometry moves through it.
 */

export const MAX_PATHS = 64;
export const BAKE_BOUND = 1.25;

export const VERT = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_pos;
void main() {
  v_pos = a_pos;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

export const BAKE_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 v_pos;
out vec4 o;

uniform highp sampler2D u_segments; // RGBA32F, 2 texels per cubic
uniform int   u_pathCount;
uniform int   u_pathEnds[${MAX_PATHS}];
uniform float u_pathTone[${MAX_PATHS}];
uniform float u_pathAngle[${MAX_PATHS}];
uniform float u_bound;

vec2 bez(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
  float u = 1.0 - t;
  return u*u*u*p0 + 3.0*u*u*t*p1 + 3.0*u*t*t*p2 + t*t*t*p3;
}
vec2 bezD(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
  float u = 1.0 - t;
  return 3.0*u*u*(p1 - p0) + 6.0*u*t*(p2 - p1) + 3.0*t*t*(p3 - p2);
}

// Same estimator as core's SDF_BODY: 16-step crossing walk for parity,
// 12-sample coarse search + 3 Newton steps for the closest point.
float distToCubic(vec2 p, vec2 p0, vec2 p1, vec2 p2, vec2 p3, inout int crossings) {
  float prevY = p0.y - p.y;
  float prevX = p0.x;
  for (int i = 1; i <= 16; i++) {
    vec2 b = bez(p0, p1, p2, p3, float(i) / 16.0);
    float y = b.y - p.y;
    if ((prevY <= 0.0 && y > 0.0) || (prevY > 0.0 && y <= 0.0)) {
      float xc = mix(prevX, b.x, prevY / (prevY - y));
      if (xc > p.x) crossings += 1;
    }
    prevY = y;
    prevX = b.x;
  }
  float bestT = 0.0;
  float bestD2 = 1e20;
  for (int i = 0; i <= 12; i++) {
    float t = float(i) / 12.0;
    vec2 b = bez(p0, p1, p2, p3, t);
    float d2 = dot(b - p, b - p);
    if (d2 < bestD2) { bestD2 = d2; bestT = t; }
  }
  for (int i = 0; i < 3; i++) {
    vec2 diff = bez(p0, p1, p2, p3, bestT) - p;
    vec2 db = bezD(p0, p1, p2, p3, bestT);
    float u = 1.0 - bestT;
    vec2 ddb = 6.0*u*(p2 - 2.0*p1 + p0) + 6.0*bestT*(p3 - 2.0*p2 + p1);
    float fp = dot(db, db) + dot(diff, ddb);
    if (abs(fp) > 1e-8) bestT = clamp(bestT - dot(diff, db) / fp, 0.0, 1.0);
  }
  return length(bez(p0, p1, p2, p3, bestT) - p);
}

void main() {
  vec2 p = v_pos * u_bound;
  float result = 1e20;
  float tone = 1.0;
  float angle = 0.0;
  int prevEnd = 0;
  for (int pi = 0; pi < ${MAX_PATHS}; pi++) {
    if (pi >= u_pathCount) break;
    int segEnd = u_pathEnds[pi];
    float minD = 1e20;
    int crossings = 0;
    for (int s = prevEnd; s < segEnd; s++) {
      vec4 a = texelFetch(u_segments, ivec2(s * 2, 0), 0);
      vec4 b = texelFetch(u_segments, ivec2(s * 2 + 1, 0), 0);
      minD = min(minD, distToCubic(p, a.xy, a.zw, b.xy, b.zw, crossings));
    }
    float sd = (crossings % 2 == 1) ? -minD : minD;
    if (sd < result) { result = sd; tone = u_pathTone[pi]; angle = u_pathAngle[pi]; }
    prevEnd = segEnd;
  }
  o = vec4(result, tone, angle, 1.0);
}
`;

export const INK_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_pos;
out vec4 o;

uniform sampler2D u_sdf;
uniform float u_bound;
uniform vec2  u_res;
uniform float u_zoom;
uniform vec2  u_pan;
uniform float u_seed;

uniform float u_inkLoad;     // overall pigment density
uniform float u_wetEdge;     // strength of the dark drying rim
uniform float u_blotch;      // contour domain-warp amount
uniform float u_dry;         // dry-brush breakup
uniform float u_bleed;       // capillary bleed into the fibres
uniform float u_grain;       // paper relief
uniform float u_granulation; // pigment settling into paper valleys
uniform vec3  u_ink;
uniform vec3  u_paper;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = ROT * p * 2.03 + 11.7;
    a *= 0.5;
  }
  return s / 0.96875;
}
float fbm3(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p = ROT * p * 2.07 + 3.1;
    a *= 0.5;
  }
  return s / 0.875;
}

/**
 * Zoom-adaptive fbm: keeps adding octaves until a cell shrinks to about a
 * pixel, fading the last one in, so paper and ink edges keep showing new
 * detail at close zoom instead of blurring into smooth value noise.
 */
float detail(vec2 p, float f0, float px) {
  float s = 0.0;
  float a = 0.5;
  float norm = 0.0;
  float f = f0;
  for (int i = 0; i < 12; i++) {
    float w = smoothstep(1.0, 3.0, 1.0 / (f * px));
    if (w <= 0.0) break;
    s += a * w * vnoise(p * f + float(i) * 7.3);
    norm += a * w;
    p = ROT * p;
    f *= 2.07;
    a *= 0.55;
  }
  return norm > 0.0 ? s / norm : 0.5;
}

vec2 bakeUV(vec2 p) { return p / (2.0 * u_bound) + 0.5; }
bool outsideBake(vec2 uv) { return any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))); }

/** (distance, tone), clamped to "far outside" past the bake. */
vec2 sdfAt(vec2 p) {
  vec2 uv = bakeUV(p);
  if (outsideBake(uv)) return vec2(1.0, 1.0);
  return texture(u_sdf, uv).rg;
}

/** Dry-brush hair streaks for one brush direction, 0..1. */
float streakFor(vec2 sp, float angle, float warp) {
  vec2 dir = vec2(cos(angle), sin(angle));
  vec2 bq = vec2(dot(sp, dir), dot(sp, vec2(-dir.y, dir.x)));
  vec2 sq = bq * vec2(3.0, 200.0) + vec2(0.0, warp);
  return 0.65 * vnoise(sq) + 0.35 * vnoise(sq * vec2(1.7, 2.3) + 4.1);
}

/**
 * Streaks with the brush angle filtered by hand. Interpolating the angle
 * itself would invent in-between directions where two strokes meet, so
 * instead each of the four nearest texels' angles yields its own streak
 * value and those are blended bilinearly: a soft crossfade at seams.
 */
float streakAt(vec2 p, vec2 sp, float warp) {
  vec2 uv = bakeUV(p);
  if (outsideBake(uv)) return 0.0;
  ivec2 size = textureSize(u_sdf, 0);
  vec2 t = uv * vec2(size) - 0.5;
  ivec2 i0 = ivec2(floor(t));
  vec2 f = t - floor(t);
  ivec2 hi = size - 1;
  float a00 = texelFetch(u_sdf, clamp(i0, ivec2(0), hi), 0).b;
  float a10 = texelFetch(u_sdf, clamp(i0 + ivec2(1, 0), ivec2(0), hi), 0).b;
  float a01 = texelFetch(u_sdf, clamp(i0 + ivec2(0, 1), ivec2(0), hi), 0).b;
  float a11 = texelFetch(u_sdf, clamp(i0 + ivec2(1, 1), ivec2(0), hi), 0).b;
  float s00 = streakFor(sp, a00, warp);
  // Inside a single stroke all four agree; skip the extra noise lookups.
  if (abs(a10 - a00) + abs(a01 - a00) + abs(a11 - a00) < 1e-3) return s00;
  return mix(mix(s00, streakFor(sp, a10, warp), f.x),
             mix(streakFor(sp, a01, warp), streakFor(sp, a11, warp), f.x), f.y);
}

/** Long thin fibres at a few orientations, 0..1. */
float fibres(vec2 p) {
  float f = 0.0;
  for (int i = 0; i < 3; i++) {
    float a = float(i) * 2.1 + 0.4;
    vec2 r = mat2(cos(a), sin(a), -sin(a), cos(a)) * p;
    r.y += 0.03 * (vnoise(r * 2.5 + float(i)) - 0.5); // wavy, not ruled
    float n = vnoise(r * vec2(5.0, 140.0) + float(i) * 31.0);
    f += smoothstep(0.72, 0.96, n) * (0.6 + 0.4 * vnoise(r * 2.0));
  }
  return clamp(f, 0.0, 1.0);
}

void main() {
  float px = 2.2 / min(u_res.x, u_res.y) / u_zoom; // logo units per pixel
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) * px + u_pan;
  vec2 sp = p + vec2(u_seed * 17.31, u_seed * -9.17);

  // ---- Paper -------------------------------------------------------------
  float mott = fbm(sp * 1.4);
  float grain = detail(sp, 85.0, px);
  // A finer generation of fibres fades in once zoomed past ~4x.
  float fib = max(fibres(sp), 0.6 * fibres(sp * 5.0 + 2.9) * smoothstep(0.0015, 0.0006, px));
  // Emboss the grain with a fixed light from the upper left. Slope is
  // measured per pixel, so the relief stays crisp at every zoom.
  float e = px * 1.5;
  float gx = detail(sp + vec2(e, 0.0), 85.0, px) - grain;
  float gy = detail(sp + vec2(0.0, e), 85.0, px) - grain;
  float relief = clamp((gy - gx) * 2.5, -0.5, 0.5);
  vec3 paper = u_paper * (0.93 + 0.09 * mott);
  paper *= 1.0 + u_grain * (0.07 * relief - 0.04 * (0.5 - grain));
  paper = mix(paper, paper * vec3(1.03, 1.02, 0.98), fib * 0.6);
  paper -= vec3(0.02, 0.025, 0.03) * fib * u_grain;

  // ---- Ink ---------------------------------------------------------------
  // Blotchy contour: warp the SDF lookup by low- and high-frequency noise.
  vec2 wLo = vec2(fbm(sp * 3.0 + 1.7), fbm(sp * 3.0 + 9.2)) - 0.5;
  // The high band is fractal down to pixel scale: ink edges on absorbent
  // paper stay ragged however close you look.
  vec2 wHi = vec2(detail(sp, 24.0, px), detail(sp + 5.3, 24.0, px)) - 0.5;
  vec2 q = p + u_blotch * (0.055 * wLo + 0.007 * wHi);
  vec2 st = sdfAt(q);
  float d = st.x;
  float tone = st.y;

  // Capillary bleed: the hard edge creeps outward into the paper's
  // valleys; fibres carry a soft feather (the halo below), not the edge.
  float wick = u_bleed * (0.004 + 0.008 * (1.0 - grain)) * (0.4 + mott);
  float de = d - wick;
  float cov = smoothstep(px, -px, de);
  float depth = max(-de, 0.0);

  // Pigment density: uneven pooling, then the wet-edge rim on top.
  float pool = fbm(sp * 4.2 + 3.1);
  float dens = u_inkLoad * tone * (0.62 + 0.75 * (pool - 0.5));
  float rimW = 0.007 + 0.012 * vnoise(sp * 7.0);
  dens += u_wetEdge * 0.6 * tone * exp(-depth / rimW);
  dens += u_granulation * 0.35 * (0.5 - grain) * dens;

  // Dry brush: hair streaks along the stroke's brush direction, gated by a
  // low-frequency "brush running out" mask, plus paper tooth where driest.
  float streak = streakAt(q, sp, fbm3(sp * 2.5) * 6.0);
  float dryField = fbm(sp * 1.25 + 7.0);
  float dryness = clamp(u_dry * 1.6 * smoothstep(0.35, 0.75, dryField + 0.25 * u_dry), 0.0, 1.0);
  float gap = smoothstep(0.45, 0.58, streak) * dryness;
  float tooth = detail(sp, 220.0, px);
  gap = max(gap, dryness * dryness * smoothstep(0.5, 0.36, tooth) * 0.3);
  // Keep the outermost rim intact a little: the brush edge holds ink longest.
  gap *= smoothstep(0.0, 0.012, depth);
  dens *= 1.0 - 0.85 * gap;
  cov *= 1.0 - 0.75 * gap;

  // Faint halo where water carried diluted pigment past the edge.
  float halo = u_bleed * 0.2 * exp(-max(de, 0.0) / (0.004 + 0.012 * fib)) * (0.6 + 0.4 * fib) * (1.0 - cov);

  // Beer-Lambert-ish: density stacks toward full black instead of linearly.
  float a = clamp(cov * (1.0 - exp(-2.3 * dens)) + halo, 0.0, 1.0);
  // Dilute ink reads warmer/greyer than full-strength sumi.
  vec3 ink = mix(u_ink + vec3(0.12, 0.10, 0.07), u_ink, smoothstep(0.2, 0.9, a));
  vec3 col = paper * mix(vec3(1.0), ink, a);

  // Soft vignette, like an aged sheet under a lamp.
  vec2 uv = gl_FragCoord.xy / u_res - 0.5;
  col *= 1.0 - 0.18 * dot(uv, uv);

  o = vec4(col, 1.0);
}
`;
