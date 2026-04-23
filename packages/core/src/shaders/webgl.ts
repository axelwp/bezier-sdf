/**
 * GLSL ES 1.00 shaders for the WebGL renderer.
 *
 * Architecture:
 *   1. BAKE pass — runs once per path at init. Evaluates the signed-
 *      distance field for a path's cubic Beziers over a square [-BOUND,
 *      BOUND]² region and writes the scalar distance to the R channel of
 *      a half-float FBO. The resulting texture can be sampled cheaply
 *      forever after.
 *   2. SAMPLE pass — runs every frame. Samples each path's baked SDF at
 *      a translated UV (so each sub-shape can animate independently),
 *      smooth-unions the results, rasterizes the silhouette with fwidth-
 *      based anti-aliasing.
 *
 * If half-float textures aren't available, DIRECT_FRAG evaluates one
 * combined SDF per pixel. Slower but always works — no animation because
 * per-frame SDF evaluation is too expensive to animate smoothly with
 * many segments.
 *
 * BOUND=1.2 covers the [-1, 1] normalized logo plus margin for animation-
 * time translation at zoom≈1. If you translate sub-paths further than
 * that, edges of the baked texture will clamp.
 */

export const MAX_SEGS = 32;
export const MAX_PATHS = 4;

/** Shared SDF evaluator, consumes u_segA/u_segB/u_segCount. */
const SDF_BODY = /* glsl */ `
#define MAX_SEGS 32
uniform int  u_segCount;
uniform vec4 u_segA[MAX_SEGS];
uniform vec4 u_segB[MAX_SEGS];

vec2 bezier(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
  float u = 1.0 - t;
  return u*u*u * p0 + 3.0*u*u*t * p1 + 3.0*u*t*t * p2 + t*t*t * p3;
}
vec2 bezierDeriv(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
  float u = 1.0 - t;
  return 3.0*u*u * (p1 - p0) + 6.0*u*t * (p2 - p1) + 3.0*t*t * (p3 - p2);
}
float distToCubic(vec2 p, vec2 p0, vec2 p1, vec2 p2, vec2 p3, inout int crossings) {
  const int NS = 16;
  float prevY = p0.y - p.y;
  float prevX = p0.x;
  for (int i = 1; i <= NS; i++) {
    float t = float(i) / float(NS);
    vec2 b = bezier(p0, p1, p2, p3, t);
    float y = b.y - p.y;
    if ((prevY <= 0.0 && y > 0.0) || (prevY > 0.0 && y <= 0.0)) {
      float s = prevY / (prevY - y);
      float xc = mix(prevX, b.x, s);
      if (xc > p.x) crossings += 1;
    }
    prevY = y;
    prevX = b.x;
  }
  float bestT = 0.0;
  float bestD2 = 1e20;
  const int NC = 12;
  for (int i = 0; i <= NC; i++) {
    float t = float(i) / float(NC);
    vec2 b = bezier(p0, p1, p2, p3, t);
    float d2 = dot(b - p, b - p);
    if (d2 < bestD2) { bestD2 = d2; bestT = t; }
  }
  for (int i = 0; i < 3; i++) {
    vec2 b  = bezier(p0, p1, p2, p3, bestT);
    vec2 db = bezierDeriv(p0, p1, p2, p3, bestT);
    vec2 diff = b - p;
    float u = 1.0 - bestT;
    vec2 ddb = 6.0*u*(p2 - 2.0*p1 + p0) + 6.0*bestT*(p3 - 2.0*p2 + p1);
    float f  = dot(diff, db);
    float fp = dot(db, db) + dot(diff, ddb);
    if (abs(fp) > 1e-8) {
      bestT = clamp(bestT - f / fp, 0.0, 1.0);
    }
  }
  vec2 b = bezier(p0, p1, p2, p3, bestT);
  return length(b - p);
}
float sceneSDF(vec2 p) {
  float minD = 1e20;
  int crossings = 0;
  for (int i = 0; i < MAX_SEGS; i++) {
    if (i >= u_segCount) break;
    vec4 a = u_segA[i];
    vec4 b = u_segB[i];
    float d = distToCubic(p, a.xy, a.zw, b.xy, b.zw, crossings);
    if (d < minD) minD = d;
  }
  bool inside = (crossings - (crossings / 2) * 2) == 1;
  return inside ? -minD : minD;
}
`;

/** Fullscreen-quad vertex shader used by sample + direct paths. */
export const WEBGL_VERT = /* glsl */ `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/** Bake vertex shader — passes UV scaled to the bake bound. */
export const WEBGL_BAKE_VERT = /* glsl */ `
attribute vec2 a_pos;
varying vec2 v_uv;
uniform float u_bound;
void main() {
  v_uv = a_pos * u_bound;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

/** Bake fragment — writes raw signed distance to R channel. */
export const WEBGL_BAKE_FRAG = /* glsl */ `
precision highp float;
varying vec2 v_uv;
${SDF_BODY}
void main() {
  gl_FragColor = vec4(sceneSDF(v_uv), 0.0, 0.0, 1.0);
}
`;

/**
 * Sample fragment. Reads up to MAX_PATHS baked SDFs, each translated by
 * its own offset, and smooth-unions the results.
 *
 * We can't index samplers dynamically in GLSL ES 1.00, so we unroll by
 * path count up to MAX_PATHS=4. u_pathCount tells the shader how many
 * are actually bound.
 */
export const WEBGL_SAMPLE_FRAG = /* glsl */ `
#extension GL_OES_standard_derivatives : enable
precision highp float;

uniform vec2  u_res;
uniform float u_zoom;
uniform vec2  u_offset;
uniform vec3  u_color;
uniform float u_opacity;

uniform float u_bound;
uniform float u_sminK;
uniform int   u_pathCount;
uniform sampler2D u_sdf0;
uniform sampler2D u_sdf1;
uniform sampler2D u_sdf2;
uniform sampler2D u_sdf3;
uniform vec2 u_pathOffset0;
uniform vec2 u_pathOffset1;
uniform vec2 u_pathOffset2;
uniform vec2 u_pathOffset3;
uniform vec2  u_cursor;
uniform float u_cursorPull;
uniform float u_cursorRadius;
uniform vec4  u_ripples[4]; // (x, y, age, amplitude) per slot

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float sampleAt(sampler2D sdf, vec2 uv, vec2 pathOffset) {
  vec2 local = uv - pathOffset;
  vec2 t = clamp((local / u_bound) * 0.5 + 0.5, 0.0, 1.0);
  return texture2D(sdf, t).r;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  uv *= 2.0 / u_zoom;
  uv -= u_offset;

  float k = max(u_sminK, 1e-4);
  // Seed with path 0 (always present). Union successive paths in.
  float d = sampleAt(u_sdf0, uv, u_pathOffset0);
  if (u_pathCount > 1) d = smin(d, sampleAt(u_sdf1, uv, u_pathOffset1), k);
  if (u_pathCount > 2) d = smin(d, sampleAt(u_sdf2, uv, u_pathOffset2), k);
  if (u_pathCount > 3) d = smin(d, sampleAt(u_sdf3, uv, u_pathOffset3), k);

  // Liquid-cursor pull — subtract an inverse-square radial field from the
  // scene SDF. Locally reduces the distance value, so the zero-contour
  // (the silhouette edge) bulges out toward the cursor and fuses with it
  // when close. u_cursorPull=0 disables; u_cursorRadius is a softening
  // epsilon (smaller = sharper/narrower tendril).
  vec2 toCursor = u_cursor - uv;
  d -= u_cursorPull / (dot(toCursor, toCursor) + u_cursorRadius);

  // Up to 4 concurrent shockwave rings. JS advances each ring's radius
  // (ripples[i].z) and tapers its amplitude (ripples[i].w) independently.
  // Dead slots (amplitude=0) contribute nothing.
  const float RIPPLE_WIDTH = 0.12;
  for (int i = 0; i < 4; i++) {
    vec4 r = u_ripples[i];
    float rd = length(uv - r.xy);
    float rp = (rd - r.z) / RIPPLE_WIDTH;
    d -= r.w * exp(-rp * rp);
  }

  float aa = fwidth(d) * 1.2;
  float mask = 1.0 - smoothstep(-aa, aa, d);
  gl_FragColor = vec4(u_color, mask * u_opacity);
}
`;

/**
 * Direct fragment — evaluates one combined SDF per pixel. Used when
 * half-float texture extensions are unavailable, or when the caller
 * explicitly opts out of baking (`mode: 'direct'`).
 */
export const WEBGL_DIRECT_FRAG = /* glsl */ `
#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec2  u_res;
uniform float u_zoom;
uniform vec2  u_offset;
uniform vec3  u_color;
uniform float u_opacity;
${SDF_BODY}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  uv *= 2.0 / u_zoom;
  uv -= u_offset;
  float d = sceneSDF(uv);
  float aa = fwidth(d) * 1.2;
  float mask = 1.0 - smoothstep(-aa, aa, d);
  gl_FragColor = vec4(u_color, mask * u_opacity);
}
`;

export const WEBGL_BAKE_BOUND = 1.2;
export const WEBGL_BAKE_SIZE = 1024;
