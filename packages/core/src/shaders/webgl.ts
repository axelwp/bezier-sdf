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
 *      and either smooth-unions them (legacy single-color path, used by
 *      the reveal example) or composites them with per-path fill/stroke
 *      modes and colors (the mode used for arbitrary user SVGs).
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
 * its own offset. Supports two composition modes:
 *
 *   u_compositeMode == 0 (legacy):
 *     Smooth-union all paths together and emit a single silhouette in
 *     `u_color`. Used by the reveal example where sub-paths morph into
 *     each other and are conceptually one shape.
 *
 *   u_compositeMode == 1 (per-path):
 *     Composite paths independently using the "over" operator in SVG
 *     document order. Each path has its own mode (fill / stroke / both),
 *     colors, and opacities. Used when loading arbitrary SVGs that may
 *     have per-path paint. smin is not applied across paths in this mode
 *     — see KNOWN_LIMITATIONS.md.
 *
 * We can't index samplers dynamically in GLSL ES 1.00, so sampler and
 * per-path offset access is unrolled in `sampleIdx`.
 */
export const WEBGL_SAMPLE_FRAG = /* glsl */ `
#extension GL_OES_standard_derivatives : enable
precision highp float;

uniform vec2  u_res;
uniform float u_zoom;
uniform vec2  u_offset;
uniform float u_opacity;

// Legacy single-color smin path.
uniform vec3  u_color;
uniform float u_sminK;

uniform float u_bound;
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
uniform vec4  u_ripples[4];  // (x, y, age, amplitude) per slot

// Per-path composite uniforms (only meaningful when u_compositeMode != 0).
uniform int   u_compositeMode;
uniform ivec4 u_pathMode;            // 0=fill, 1=stroke, 2=both
uniform vec4  u_pathStrokeHalfW;
uniform vec4  u_pathFillOpacity;
uniform vec4  u_pathStrokeOpacity;
uniform vec3  u_pathFillColor0;
uniform vec3  u_pathFillColor1;
uniform vec3  u_pathFillColor2;
uniform vec3  u_pathFillColor3;
uniform vec3  u_pathStrokeColor0;
uniform vec3  u_pathStrokeColor1;
uniform vec3  u_pathStrokeColor2;
uniform vec3  u_pathStrokeColor3;

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float sampleIdx(int i, vec2 uv) {
  // Unrolled per-index fetch — GLSL ES 1.00 disallows dynamic indexing
  // of sampler arrays, and per-path offsets are kept as peer uniforms
  // so all four have the same packing.
  vec2 po = u_pathOffset0;
  if (i == 1) po = u_pathOffset1;
  else if (i == 2) po = u_pathOffset2;
  else if (i == 3) po = u_pathOffset3;
  vec2 local = uv - po;
  vec2 t = clamp((local / u_bound) * 0.5 + 0.5, 0.0, 1.0);
  if (i == 0) return texture2D(u_sdf0, t).r;
  if (i == 1) return texture2D(u_sdf1, t).r;
  if (i == 2) return texture2D(u_sdf2, t).r;
  return texture2D(u_sdf3, t).r;
}

vec3 fillColorIdx(int i) {
  if (i == 0) return u_pathFillColor0;
  if (i == 1) return u_pathFillColor1;
  if (i == 2) return u_pathFillColor2;
  return u_pathFillColor3;
}
vec3 strokeColorIdx(int i) {
  if (i == 0) return u_pathStrokeColor0;
  if (i == 1) return u_pathStrokeColor1;
  if (i == 2) return u_pathStrokeColor2;
  return u_pathStrokeColor3;
}
float v4Idx(vec4 v, int i) {
  if (i == 0) return v.x;
  if (i == 1) return v.y;
  if (i == 2) return v.z;
  return v.w;
}
int i4Idx(ivec4 v, int i) {
  if (i == 0) return v.x;
  if (i == 1) return v.y;
  if (i == 2) return v.z;
  return v.w;
}

// Total subtractive deformation field at uv — the cursor pull plus any
// active ripple rings. Returned (rather than mutating an inout d) so
// call sites can subtract it from whichever SDF they're rendering:
//
//   - For fills, subtract from the scene SDF directly (d -= field).
//     The zero-contour bulges toward the cursor.
//   - For strokes, subtract from the sausage SDF abs(d) - halfWidth.
//     That virtual region (Minkowski sum of the curve and a disk of
//     radius halfWidth) is itself a proper fill SDF — distorting it
//     thickens/warps the ink near the cursor instead of producing the
//     amoeba-blob breakdown you get from applying the field to d and
//     then taking abs.
float effectsField(vec2 uv) {
  // Cursor pull — Gaussian falloff. Bounded peak (= u_cursorPull) at
  // r = 0; ~0 past 3·u_cursorRadius. u_cursorPull = 0 disables.
  vec2 delta = uv - u_cursor;
  float r2 = dot(delta, delta);
  float sigma = max(u_cursorRadius, 1e-4);
  float total = u_cursorPull * exp(-r2 / (2.0 * sigma * sigma));

  // Up to 4 concurrent shockwave rings. JS advances each ring's radius
  // (ripples[i].z) and tapers its amplitude (ripples[i].w) independently.
  // Dead slots (amplitude=0) contribute nothing.
  const float RIPPLE_WIDTH = 0.12;
  for (int i = 0; i < 4; i++) {
    vec4 r = u_ripples[i];
    float rd = length(uv - r.xy);
    float rp = (rd - r.z) / RIPPLE_WIDTH;
    total += r.w * exp(-rp * rp);
  }
  return total;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  uv *= 2.0 / u_zoom;
  uv -= u_offset;

  float field = effectsField(uv);

  if (u_compositeMode == 0) {
    float k = max(u_sminK, 1e-4);
    float d = sampleIdx(0, uv);
    if (u_pathCount > 1) d = smin(d, sampleIdx(1, uv), k);
    if (u_pathCount > 2) d = smin(d, sampleIdx(2, uv), k);
    if (u_pathCount > 3) d = smin(d, sampleIdx(3, uv), k);
    d -= field;
    float aa = fwidth(d) * 1.2;
    float mask = 1.0 - smoothstep(-aa, aa, d);
    gl_FragColor = vec4(u_color, mask * u_opacity);
    return;
  }

  // Per-path composite: accumulate with Porter-Duff "over" in premultiplied
  // alpha, convert back to straight alpha for the straight-alpha blend
  // func configured on the GL context.
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= u_pathCount) break;
    float d = sampleIdx(i, uv);
    int mode = i4Idx(u_pathMode, i);

    // Fill layer (mode 0 or 2). Distort the scene SDF directly — the
    // boundary bulges toward the cursor.
    if (mode != 1) {
      float dFill = d - field;
      float aa = fwidth(dFill) * 1.2;
      float a = (1.0 - smoothstep(-aa, aa, dFill)) * v4Idx(u_pathFillOpacity, i);
      vec4 src = vec4(fillColorIdx(i) * a, a);
      acc = src + acc * (1.0 - src.a);
    }
    // Stroke layer (mode 1 or 2). Compute the sausage SDF first
    // (abs(d) - halfW — the SDF of the curve dilated by halfW), then
    // distort that. Same math shape as the fill case, applied to a
    // proper 2D region instead of a 1D level set, so no amoeba blobs.
    if (mode != 0) {
      float halfW = v4Idx(u_pathStrokeHalfW, i);
      float de = abs(d) - halfW - field;
      float aaS = fwidth(de) * 1.2;
      float a = (1.0 - smoothstep(-aaS, aaS, de)) * v4Idx(u_pathStrokeOpacity, i);
      vec4 src = vec4(strokeColorIdx(i) * a, a);
      acc = src + acc * (1.0 - src.a);
    }
  }
  vec3 rgb = acc.a > 1e-6 ? acc.rgb / acc.a : vec3(0.0);
  gl_FragColor = vec4(rgb, acc.a * u_opacity);
}
`;

/**
 * Liquid-glass sample fragment. Uses the baked per-path SDF textures as
 * the lens shape — smooth-unions all paths into one silhouette, computes
 * the surface normal from the sampled SDF's screen-space gradient, and
 * refracts a backdrop image through it. Per-path colors and animation
 * offsets don't apply in glass mode (the shape is a material, not a
 * painted silhouette).
 *
 * Ingredients, in order of visual weight:
 *   1. Refraction — sample backdrop at an offset along the inward normal,
 *      scaled by a smoothed "thickness" proxy (depth inside the shape).
 *   2. Chromatic aberration — R/G/B sampled with slightly different
 *      offset magnitudes. Produces subtle rainbow fringing on curvature.
 *   3. Fresnel rim — narrow additive band along `|d| ≈ 0`.
 *   4. Thickness tint — mix a faint color in proportion to depth.
 *
 * No discard: running textureSample(backdrop, ...) unconditionally keeps
 * derivatives well-defined across quads and avoids implementation-
 * defined behavior when half a quad falls outside the shape. The alpha
 * channel handles masking.
 */
export const WEBGL_GLASS_FRAG = /* glsl */ `
#extension GL_OES_standard_derivatives : enable
precision highp float;

uniform vec2  u_res;
uniform float u_zoom;
uniform vec2  u_offset;
uniform float u_opacity;
uniform float u_sminK;
uniform float u_bound;
uniform int   u_pathCount;
uniform sampler2D u_sdf0;
uniform sampler2D u_sdf1;
uniform sampler2D u_sdf2;
uniform sampler2D u_sdf3;

uniform sampler2D u_backdrop;
uniform float u_refractionStrength;
uniform float u_chromaticStrength;
uniform float u_fresnelStrength;
uniform float u_tintStrength;
uniform float u_frostStrength;
uniform vec3  u_rimColor;
uniform vec3  u_tintColor;

uniform vec2  u_cursor;
uniform float u_cursorPull;
uniform float u_cursorRadius;
uniform vec4  u_ripples[4];
uniform vec2  u_pathOffset0;
uniform vec2  u_pathOffset1;
uniform vec2  u_pathOffset2;
uniform vec2  u_pathOffset3;

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float sampleSdf(int i, vec2 uv) {
  vec2 po = u_pathOffset0;
  if (i == 1) po = u_pathOffset1;
  else if (i == 2) po = u_pathOffset2;
  else if (i == 3) po = u_pathOffset3;
  vec2 local = uv - po;
  vec2 t = clamp((local / u_bound) * 0.5 + 0.5, 0.0, 1.0);
  if (i == 0) return texture2D(u_sdf0, t).r;
  if (i == 1) return texture2D(u_sdf1, t).r;
  if (i == 2) return texture2D(u_sdf2, t).r;
  return texture2D(u_sdf3, t).r;
}

float combinedSdf(vec2 uv) {
  float k = max(u_sminK, 1e-4);
  float d = sampleSdf(0, uv);
  if (u_pathCount > 1) d = smin(d, sampleSdf(1, uv), k);
  if (u_pathCount > 2) d = smin(d, sampleSdf(2, uv), k);
  if (u_pathCount > 3) d = smin(d, sampleSdf(3, uv), k);
  return d;
}

// Mirror of the sample shader's effectsField. Subtracted from the lens
// SDF at every evaluation site so glass composes with cursor pull and
// ripple deformations.
float effectsField(vec2 uv) {
  vec2 delta = uv - u_cursor;
  float r2 = dot(delta, delta);
  float sigma = max(u_cursorRadius, 1e-4);
  float total = u_cursorPull * exp(-r2 / (2.0 * sigma * sigma));
  const float RIPPLE_WIDTH = 0.12;
  for (int i = 0; i < 4; i++) {
    vec4 r = u_ripples[i];
    float rd = length(uv - r.xy);
    float rp = (rd - r.z) / RIPPLE_WIDTH;
    total += r.w * exp(-rp * rp);
  }
  return total;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  uv *= 2.0 / u_zoom;
  uv -= u_offset;

  float d = combinedSdf(uv) - effectsField(uv);
  float aa = fwidth(d) * 1.2;
  float insideMask = 1.0 - smoothstep(-aa, aa, d);

  // --- Lens height field ---
  //
  // Every function of the SDF has a zero-gradient set along the shape's
  // medial axis — that's a property of the SDF itself (local extremum
  // of depth), not something blurring can remove. Using such a field
  // directly as a lens produces faceted refraction along the creases,
  // no matter how finely you smooth.
  //
  // So we don't build the height field from the SDF. We build it from
  // a *smoothed indicator function*: convert each SDF sample to a soft
  // inside/outside value via smoothstep (1 inside, 0 outside), then
  // average over a 9-tap radial kernel. The resulting h is a genuine
  // smooth dome — flat plateau in the interior (indicator=1 everywhere
  // in the neighborhood) and a smooth rising edge at the rim. Its
  // gradient is rim-concentrated without medial-axis creases, which is
  // the actual geometry of a liquid-glass bevel.
  //
  // 9 SDF evaluations per fragment, per path. For typical 1-path logos
  // that's 9 texture reads; well within budget.
  const float SDF_BLUR = 0.08;   // radial sample distance in SDF space
  const float SOFT_EDGE = 0.03;  // half-width of the inside/outside ramp
  const float D = 0.70710678 * SDF_BLUR;  // diagonal tap distance (= B/√2)

  float h  = (1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv) - effectsField(uv))) * 2.0;
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv + vec2(SDF_BLUR, 0.0)) - effectsField(uv + vec2(SDF_BLUR, 0.0)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv - vec2(SDF_BLUR, 0.0)) - effectsField(uv - vec2(SDF_BLUR, 0.0)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv + vec2(0.0, SDF_BLUR)) - effectsField(uv + vec2(0.0, SDF_BLUR)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv - vec2(0.0, SDF_BLUR)) - effectsField(uv - vec2(0.0, SDF_BLUR)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv + vec2( D,  D)) - effectsField(uv + vec2( D,  D)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv + vec2( D, -D)) - effectsField(uv + vec2( D, -D)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv + vec2(-D,  D)) - effectsField(uv + vec2(-D,  D)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, combinedSdf(uv + vec2(-D, -D)) - effectsField(uv + vec2(-D, -D)));
  h /= 10.0;  // center weight 2 + 8 outer = 10

  // Gradient of the smoothed indicator. Points *inward* (toward the
  // interior plateau where h → 1). Magnitude peaks at the rim and falls
  // to zero in the interior — exactly the rim-concentrated profile we
  // want, derived naturally rather than hand-tuned.
  vec2 grad = vec2(dFdx(h), dFdy(h));
  float gradMag = length(grad);
  vec2 normal = grad / max(gradMag, 1e-6);

  // Lens intensity: (1 - h) doubled. At the rim h≈0.5 so peaks at 1; in
  // the flat interior h=1 so decays to 0. Replaces the old explicit
  // exp(-depth*k) profile — this one falls out of the height field.
  float lensAmount = clamp((1.0 - h) * 2.0, 0.0, 1.0);

  // Interior proxy for tint and frost, also derived from h so tint
  // bands follow the smoothed height field instead of the SDF's
  // iso-contours (which have medial-axis cusps and would paint those
  // same creases into the tint).
  float interior = smoothstep(0.5, 1.0, h);

  // Convert the isotropic SDF-space offset to backdrop-uv space and
  // refract along the inward normal.
  vec2 sdfToUv = vec2(min(u_res.x, u_res.y)) / u_res;
  vec2 refractOffset = normal * lensAmount * u_refractionStrength * sdfToUv;

  vec2 backdropUv = gl_FragCoord.xy / u_res;
  vec2 offR = backdropUv + refractOffset * (1.0 - u_chromaticStrength);
  vec2 offG = backdropUv + refractOffset;
  vec2 offB = backdropUv + refractOffset * (1.0 + u_chromaticStrength);

  // Backdrop color, two-part:
  //   - Chromatic sample, sharp, used at the rim. Three taps at
  //     channel-specific offsets. Chroma scales with lensAmount because
  //     it rides on refractOffset, so the fringe only appears at the rim.
  //   - Frosted sample, soft, used across the interior. A 5-tap cross
  //     average at uvG gives a cheap box-ish blur. Radius scales with
  //     interior so the rim stays sharp; full blur in the center reads
  //     as the "slightly frosted window" liquid-glass look.
  vec3 uvG_rgb = texture2D(u_backdrop, offG).rgb;
  float rCh = texture2D(u_backdrop, offR).r;
  float bCh = texture2D(u_backdrop, offB).b;
  vec3 chromaticColor = vec3(rCh, uvG_rgb.g, bCh);

  // Always sample unconditionally. When frostPx≈0 the four offsets
  // collapse onto offG and the average is a no-op; keeping it out of a
  // branch also dodges derivative-uniformity concerns in the WGSL twin.
  float frostPx = u_frostStrength * interior;
  vec2 fs = vec2(frostPx) / u_res;
  vec3 frost = uvG_rgb;
  frost += texture2D(u_backdrop, offG + vec2(fs.x, 0.0)).rgb;
  frost += texture2D(u_backdrop, offG - vec2(fs.x, 0.0)).rgb;
  frost += texture2D(u_backdrop, offG + vec2(0.0, fs.y)).rgb;
  frost += texture2D(u_backdrop, offG - vec2(0.0, fs.y)).rgb;
  frost *= 0.2;

  // Blend: rim = crisp chromatic split, interior = frost.
  vec3 color = mix(frost, chromaticColor, lensAmount);

  // Fresnel rim — bright narrow band along the shape's edge.
  float rim = 1.0 - smoothstep(0.0, 0.02, abs(d));
  color += u_rimColor * rim * u_fresnelStrength;

  // Interior tint — slight color wash in proportion to depth.
  color = mix(color, u_tintColor, clamp(interior * u_tintStrength, 0.0, 1.0));

  gl_FragColor = vec4(color, insideMask * u_opacity);
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
