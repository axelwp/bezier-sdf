import { MAX_PATHS, WEBGL_SDF_BODY } from '@bezier-sdf/core';

/**
 * GLSL ES 3.00 shaders for the ink-wash example.
 *
 * Two passes, mirroring the core renderer's bake/sample split:
 *
 *   1. BAKE — evaluates the mark's signed distance straight from its cubic
 *      Beziers over [-BOUND, BOUND]² into an RGBA16F texture, using core's
 *      own sceneSDF (nonzero rule). R holds the signed distance. G holds the "ink tone" of
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

export { MAX_PATHS };
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
precision highp sampler2D;
// Core's estimator is written in GLSL ES 1.00; map its texture call.
#define texture2D texture
in vec2 v_pos;
out vec4 o;

uniform float u_pathTone[${MAX_PATHS}];
uniform float u_pathAngle[${MAX_PATHS}];
uniform float u_bound;

// Core's own bake estimator: per-path even-odd parity hard-unioned with
// min(), stroked paths as sausage SDFs. Shared, so fixes reach this too.
${WEBGL_SDF_BODY}

void main() {
  int win;
  float d = sceneSDF(v_pos * u_bound, win);
  o = vec4(d, u_pathTone[win], u_pathAngle[win], 1.0);
}
`;

export const INK_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_pos;
out vec4 o;

uniform highp sampler2D u_sdf;
uniform float u_bound;
uniform vec2  u_res;
uniform float u_zoom;
uniform vec2  u_pan;
uniform vec2  u_seedLat; // integer lattice offset: reseeds without moving coordinates

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
  // The seed shifts which lattice cell feeds the hash, not the sample
  // position, so coordinates stay small and fract() stays exact however
  // deep the zoom-adaptive octaves go.
  i += u_seedLat;
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
  vec2 sp = p;

  // ---- Paper -------------------------------------------------------------
  float mott = fbm(sp * 1.4);
  float grain = detail(sp, 85.0, px);
  // A finer generation of fibres fades in once zoomed past ~4x.
  float fib = max(fibres(sp), 0.6 * fibres(sp * 5.0 + 2.9) * (1.0 - smoothstep(0.0006, 0.0015, px)));
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
  float cov = 1.0 - smoothstep(-px, px, de);
  float depth = max(-de, 0.0);
  float edgeCov = cov; // coverage before dry-brush gaps, for the halo

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
  gap = max(gap, dryness * dryness * (1.0 - smoothstep(0.36, 0.5, tooth)) * 0.3);
  // Keep the outermost rim intact a little: the brush edge holds ink longest.
  gap *= smoothstep(0.0, 0.012, depth);
  dens *= 1.0 - 0.85 * gap;
  cov *= 1.0 - 0.75 * gap;

  // Faint halo where water carried diluted pigment past the edge. Gated on
  // the pre-gap coverage so it stays outside the stroke, not in dry holes.
  float halo = u_bleed * 0.2 * exp(-max(de, 0.0) / (0.004 + 0.012 * fib)) * (0.6 + 0.4 * fib) * (1.0 - edgeCov);

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
