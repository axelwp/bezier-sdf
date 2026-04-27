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

/**
 * Upper bound on paths per mark (== baked SDF textures bound to the
 * sample/glass programs). Raised from 4 so multi-subpath SVGs — shapes
 * with holes, rings, compound icons that use multiple M commands in one
 * `<path>` — render every subpath instead of being truncated.
 *
 * Uses one fragment texture unit per path; glass additionally needs one
 * for the backdrop, so the programs consume up to 17 units. WebGL 1
 * guarantees ≥ 8, but every GPU shipped this decade exposes ≥ 16, so
 * link failure in practice only means a non-conformant driver.
 */
export const MAX_PATHS = 16;

/**
 * Per-fragment loop bound for the cubic segment walk. GLSL ES 1.00
 * requires the loop's upper bound to be a compile-time constant, so we
 * pick a value generous enough to cover any realistic SVG (Lucide /
 * Heroicons rarely exceed a few hundred cubics per path; 1024 leaves
 * room for the morph-combined case and unusual artwork) and let
 * `u_segCount` drive the runtime exit. Drivers that unroll just compile
 * the dead tail away.
 *
 * Also serves as the validation cap on segments per bake — anything
 * higher would silently truncate at the runtime break, so we throw at
 * mark-validation time instead.
 */
export const MAX_LOOP_BOUND = 1024;

/**
 * Shared SDF evaluator. Cubic segments live in a 1-row RGBA float
 * texture (`u_segments`): for segment `i`, texel `2i` packs `(P0, P1)`
 * and texel `2i+1` packs `(P2, P3)`. The texture is sampled with
 * NEAREST filtering, so each fetch returns the exact stored values.
 *
 * The runtime `u_segCount` upper-bounds the loop; `MAX_LOOP_BOUND` is a
 * compile-time ceiling required by the GLSL ES 1.00 spec. The texture
 * itself has no fixed size — bake-time code allocates exactly
 * `2 * segCount` texels per shape.
 */
const SDF_BODY = /* glsl */ `
uniform int       u_segCount;
uniform sampler2D u_segments;
uniform float     u_segmentTexWidth;

vec4 fetchSeg(int i) {
  float u = (float(i) + 0.5) / u_segmentTexWidth;
  return texture2D(u_segments, vec2(u, 0.5));
}

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
  for (int i = 0; i < ${MAX_LOOP_BOUND}; i++) {
    if (i >= u_segCount) break;
    vec4 a = fetchSeg(i * 2);
    vec4 b = fetchSeg(i * 2 + 1);
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
 * GLSL ES 1.00 can't dynamically index a sampler2D array — the spec only
 * permits "constant-index-expressions" (constants, loop indices in a
 * for-loop with a constant bound, …). Our composition loop has pathCount
 * as a runtime-bounded upper limit, so the classic workaround is to name
 * each sampler individually and dispatch with an unrolled if-chain. These
 * strings build that unrolled plumbing at module-load time, keyed off
 * {@link MAX_PATHS} so bumping it doesn't mean hand-editing 16+ branches.
 */
const SDF_SAMPLER_DECLS = Array.from({ length: MAX_PATHS }, (_, i) =>
  `uniform sampler2D u_sdf${i};`,
).join('\n');

const SAMPLE_IDX_BRANCHES = Array.from({ length: MAX_PATHS }, (_, i) =>
  `  if (i == ${i}) return texture2D(u_sdf${i}, t).r;`,
).join('\n');

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
 *     document order at rest, so user SVGs render with correct per-path
 *     paint and overlap order. Under active cursor/ripple effects, the
 *     fills of all paths are additionally smin-fused with polynomial
 *     smooth-min and their colors blend via the same mix-weight; the
 *     blend ramps in with `effectsField` so the fusion is localized to
 *     the distorted region and the at-rest result is unchanged.
 *     Strokes never participate in the color-blend (their half-width is
 *     per-path, so cross-path smin of sausage SDFs is ill-defined);
 *     they composite "over" on top of the blended fill unchanged.
 *
 * Per-path scalars (mode, strokeHalfW, fill/stroke opacity) are packed
 * into four-wide vec4/ivec4 arrays so a single uniform handles 16 paths
 * in four slots; the helpers `v4Idx`/`i4Idx` unpack `array[i>>2][i&3]`.
 * Fill/stroke colors live in dynamically-indexable vec3 arrays (allowed
 * in GLSL ES 1.00 for non-sampler uniforms).
 */
export const WEBGL_SAMPLE_FRAG = /* glsl */ `
#extension GL_OES_standard_derivatives : enable
precision highp float;

#define MAX_PATHS ${MAX_PATHS}
#define MAX_PATH_VEC4 ${MAX_PATHS / 4}

uniform vec2  u_res;
uniform float u_zoom;
uniform vec2  u_offset;
uniform float u_opacity;

// Legacy single-color smin path.
uniform vec3  u_color;
uniform float u_sminK;

uniform float u_bound;
uniform int   u_pathCount;
${SDF_SAMPLER_DECLS}
uniform vec2  u_pathOffset[MAX_PATHS];
uniform vec2  u_cursor;
uniform float u_cursorPull;
uniform float u_cursorRadius;
uniform vec4  u_ripples[4];  // (x, y, age, amplitude) per slot

// Per-path composite uniforms (only meaningful when u_compositeMode != 0).
// Scalar-per-path values pack four per vec4/ivec4, indexed by v4Idx/i4Idx.
uniform int   u_compositeMode;
uniform ivec4 u_pathMode[MAX_PATH_VEC4];          // 0=fill, 1=stroke, 2=both
uniform vec4  u_pathStrokeHalfW[MAX_PATH_VEC4];
uniform vec4  u_pathFillOpacity[MAX_PATH_VEC4];
uniform vec4  u_pathStrokeOpacity[MAX_PATH_VEC4];
uniform vec3  u_pathFillColor[MAX_PATHS];
uniform vec3  u_pathStrokeColor[MAX_PATHS];

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// Polynomial smooth-min — iquilezles.org/articles/smin. Returns
// (smin_value, h) where 'h' is the cubic mix-weight *toward 'a'*: h → 1
// when 'a' is much smaller (a dominates), h → 0 when 'b' is much
// smaller, h = 0.5 at crossover. Callers propagate the same 'h' into a
// mix(color_b, color_a, h) to blend per-path colors coherently with the
// SDF blend. Easy to flip the sign/argument order when refactoring —
// use a two-color contrast case to sanity-check.
//
// As k → 0, (b-a)/k tends to ±∞ and h clamps to 0/1, so the h factor
// hard-selects the nearer path and the -h*(1-h)*k bump vanishes — this
// degenerates cleanly to min() and hard color selection. k must be
// strictly positive (clamped at call site) to avoid the divide.
vec2 sminPoly(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  float d = mix(b, a, h) - h * (1.0 - h) * k;
  return vec2(d, h);
}

// Coupling between the per-pixel effects field and the local smin
// strength used for color-blend fusion in per-path composite mode. At
// rest 'effectsField = 0' so 'localK = 0' and the smin path collapses
// to a hard-min color selection — pre-multiplied through smoothstep it
// contributes nothing to the final blend. Tune up for stronger bridging
// under the cursor; too high fuses paths at the effect's periphery.
const float SMIN_COUPLING = 0.3;
// Width of the transition band between pure Porter-Duff (rest) and the
// full smin-blend result (active effects). Narrow — mostly a safety
// smoothstep to avoid any aliasing at the exact zero-field boundary.
const float BLEND_EPS = 0.002;

float sampleIdx(int i, vec2 uv) {
  // Unrolled per-index fetch — GLSL ES 1.00 disallows dynamic indexing
  // of sampler arrays, so the if-chain dispatches to MAX_PATHS named
  // samplers declared above. Per-path offset lookup uses a non-sampler
  // array, which dynamic indexing *is* allowed on.
  vec2 po = u_pathOffset[i];
  vec2 local = uv - po;
  vec2 t = clamp((local / u_bound) * 0.5 + 0.5, 0.0, 1.0);
${SAMPLE_IDX_BRANCHES}
  return 0.0;
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
    // Legacy single-color smin. The effective k is boosted locally by
    // the effects field — at rest 'k = u_sminK' (author-chosen baseline);
    // under cursor/ripple the extra term strengthens fusion only where
    // the distortion reaches, so adjacent subpaths visibly bridge into
    // one liquid blob instead of each rippling independently. Output is
    // still a single color (the legacy silhouette paints 'u_color');
    // color-blend fusion is a per-path-mode feature.
    float k = max(u_sminK + field * SMIN_COUPLING, 1e-4);
    float d = sampleIdx(0, uv);
    for (int i = 1; i < MAX_PATHS; i++) {
      if (i >= u_pathCount) break;
      d = smin(d, sampleIdx(i, uv), k);
    }
    d -= field;
    float aa = fwidth(d) * 1.2;
    float mask = 1.0 - smoothstep(-aa, aa, d);
    gl_FragColor = vec4(u_color, mask * u_opacity);
    return;
  }

  // Per-path composite. Two results are computed and blended by
  // 'blendWeight', a smoothstep of 'localK = field * SMIN_COUPLING':
  //   (A) Porter-Duff "over" across independent distorted paths. Used
  //       at rest (blendWeight = 0) so per-path paint and document-order
  //       overlaps render exactly as the SVG specified.
  //   (B) Smin + color-blend across fills, with strokes composited
  //       "over" on top. Used under active effects (blendWeight → 1)
  //       so adjacent subpaths fuse into one liquid blob with smooth
  //       color gradients through the bridge.
  // The blend is smooth in 'localK' so crossing the effect threshold
  // doesn't flash a discontinuity; width is BLEND_EPS·2.
  float localK = field * SMIN_COUPLING;
  float blendWeight = smoothstep(0.0, 2.0 * BLEND_EPS, localK);

  // (A) Porter-Duff "over" — stable per-path composite. Identical to the
  // pre-session result; each path's fill and stroke distort independently
  // and stack in document order.
  vec4 overAcc = vec4(0.0);
  for (int i = 0; i < MAX_PATHS; i++) {
    if (i >= u_pathCount) break;
    float d = sampleIdx(i, uv);
    int mode = i4Idx(u_pathMode[i / 4], i - (i / 4) * 4);
    float fillOp   = v4Idx(u_pathFillOpacity[i / 4],   i - (i / 4) * 4);
    float strokeOp = v4Idx(u_pathStrokeOpacity[i / 4], i - (i / 4) * 4);
    float halfW    = v4Idx(u_pathStrokeHalfW[i / 4],   i - (i / 4) * 4);
    if (mode != 1) {
      float dFill = d - field;
      float aa = fwidth(dFill) * 1.2;
      float a = (1.0 - smoothstep(-aa, aa, dFill)) * fillOp;
      vec4 src = vec4(u_pathFillColor[i] * a, a);
      overAcc = src + overAcc * (1.0 - src.a);
    }
    if (mode != 0) {
      float de = abs(d) - halfW - field;
      float aaS = fwidth(de) * 1.2;
      float a = (1.0 - smoothstep(-aaS, aaS, de)) * strokeOp;
      vec4 src = vec4(u_pathStrokeColor[i] * a, a);
      overAcc = src + overAcc * (1.0 - src.a);
    }
  }

  // (B) Smin + color-blend across fills. Always computed (not gated on
  // blendWeight) — kept parallel with the WGSL twin, where gating on a
  // per-fragment predicate breaks the uniformity analyzer around
  // textureSample. Cost is two extra MAX_PATHS-bounded loops; when
  // blendWeight = 0 the mix below discards the result.
  float kK = max(localK, 1e-4);
  bool  hasFill = false;
  float accSdf  = 0.0;
  vec3  accCol  = vec3(0.0);
  float accOp   = 0.0;
  for (int i = 0; i < MAX_PATHS; i++) {
    if (i >= u_pathCount) break;
    int mode = i4Idx(u_pathMode[i / 4], i - (i / 4) * 4);
    if (mode != 1) {
      float d = sampleIdx(i, uv);
      float fillOp = v4Idx(u_pathFillOpacity[i / 4], i - (i / 4) * 4);
      vec3  col    = u_pathFillColor[i];
      if (!hasFill) {
        accSdf = d;
        accCol = col;
        accOp  = fillOp;
        hasFill = true;
      } else {
        vec2 sh = sminPoly(accSdf, d, kK);
        accCol = mix(col,    accCol, sh.y);
        accOp  = mix(fillOp, accOp,  sh.y);
        accSdf = sh.x;
      }
    }
  }
  vec4 blendAcc = vec4(0.0);
  if (hasFill) {
    float dFill = accSdf - field;
    float aa = fwidth(dFill) * 1.2;
    float a = (1.0 - smoothstep(-aa, aa, dFill)) * accOp;
    blendAcc = vec4(accCol * a, a);
  }
  // Strokes composite "over" the blended fill — they don't participate
  // in the color-blend smin (per-path half-widths make cross-path
  // sausage-SDF smin ill-defined).
  for (int i = 0; i < MAX_PATHS; i++) {
    if (i >= u_pathCount) break;
    int mode = i4Idx(u_pathMode[i / 4], i - (i / 4) * 4);
    if (mode != 0) {
      float d = sampleIdx(i, uv);
      float strokeOp = v4Idx(u_pathStrokeOpacity[i / 4], i - (i / 4) * 4);
      float halfW    = v4Idx(u_pathStrokeHalfW[i / 4],   i - (i / 4) * 4);
      float de = abs(d) - halfW - field;
      float aaS = fwidth(de) * 1.2;
      float a = (1.0 - smoothstep(-aaS, aaS, de)) * strokeOp;
      vec4 src = vec4(u_pathStrokeColor[i] * a, a);
      blendAcc = src + blendAcc * (1.0 - src.a);
    }
  }

  vec4 acc = mix(overAcc, blendAcc, blendWeight);
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

#define MAX_PATHS ${MAX_PATHS}
#define MAX_PATH_VEC4 ${MAX_PATHS / 4}

uniform vec2  u_res;
uniform float u_zoom;
uniform vec2  u_offset;
uniform float u_opacity;
uniform float u_sminK;
uniform float u_bound;
uniform int   u_pathCount;
${SDF_SAMPLER_DECLS}

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
uniform vec2  u_pathOffset[MAX_PATHS];

// Per-path render mode (0=fill, 1=stroke, 2=both) and stroke half-width.
// Mirrors the sample pipeline so stroked paths enter the glass shader as
// their sausage SDF (abs(d) - halfW, a proper 2D fill SDF). "both" is
// treated as fill here — a stroke overlay on top of a glass lens doesn't
// read visually. Packed four per vec4/ivec4 for 16 paths in 4 slots.
uniform ivec4 u_pathMode[MAX_PATH_VEC4];
uniform vec4  u_pathStrokeHalfW[MAX_PATH_VEC4];

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float sampleSdf(int i, vec2 uv) {
  vec2 po = u_pathOffset[i];
  vec2 local = uv - po;
  vec2 t = clamp((local / u_bound) * 0.5 + 0.5, 0.0, 1.0);
${SAMPLE_IDX_BRANCHES}
  return 0.0;
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

// Coupling between the effects field and the local smin strength used
// for cross-path fusion in glass. Added to 'u_sminK' so the at-rest
// fusion baseline is preserved (when field=0, effective k = u_sminK)
// and the cursor region gets a stronger bridge on top. Tune down
// specifically for glass if strong cursor pulls over-fuse.
const float GLASS_SMIN_COUPLING = 0.3;

// Converts a raw per-path SDF to the right fill-SDF for glass rendering:
//   - fill (0) or both (2): the scene SDF as-is
//   - stroke (1):           abs(d) - halfW, the sausage SDF (the curve
//                           dilated by halfW — itself a proper 2D fill
//                           SDF, so the glass math downstream applies
//                           unchanged).
// Then smooth-unions across all active paths with the caller-supplied
// 'k'. Caller injects 'u_sminK + localK' so fusion strengthens under
// the cursor (see 'lens' below).
float shapeSdf(vec2 uv, float k) {
  k = max(k, 1e-4);
  float d0 = sampleSdf(0, uv);
  int m0 = i4Idx(u_pathMode[0], 0);
  float h0 = v4Idx(u_pathStrokeHalfW[0], 0);
  float d = (m0 == 1) ? (abs(d0) - h0) : d0;
  for (int i = 1; i < MAX_PATHS; i++) {
    if (i >= u_pathCount) break;
    float di = sampleSdf(i, uv);
    int mi = i4Idx(u_pathMode[i / 4], i - (i / 4) * 4);
    float hi = v4Idx(u_pathStrokeHalfW[i / 4], i - (i / 4) * 4);
    float ci = (mi == 1) ? (abs(di) - hi) : di;
    d = smin(d, ci, k);
  }
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

// Combined lens SDF at 'uv': the cross-path smin silhouette minus the
// distortion field. Both the smin strength and the SDF subtraction use
// the same field at this 'uv', so under the cursor the paths fuse more
// strongly *and* the boundary bulges toward the cursor — one coherent
// localized deformation.
float lens(vec2 uv) {
  float f = effectsField(uv);
  return shapeSdf(uv, u_sminK + f * GLASS_SMIN_COUPLING) - f;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  uv *= 2.0 / u_zoom;
  uv -= u_offset;

  float d = lens(uv);
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

  float h  = (1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv))) * 2.0;
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv + vec2(SDF_BLUR, 0.0)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv - vec2(SDF_BLUR, 0.0)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv + vec2(0.0, SDF_BLUR)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv - vec2(0.0, SDF_BLUR)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv + vec2( D,  D)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv + vec2( D, -D)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv + vec2(-D,  D)));
  h += 1.0 - smoothstep(-SOFT_EDGE, SOFT_EDGE, lens(uv + vec2(-D, -D)));
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
  vec2 refractOffset = normal * h * (1.0 - h) * lensAmount * u_refractionStrength * sdfToUv;

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
  float rim = smoothstep(-0.03, -0.005, d) * (1.0 - smoothstep(-0.005, 0.0, d));
  color += u_rimColor * rim * u_fresnelStrength;

  // Interior tint — slight color wash in proportion to depth.
  color = mix(color, u_tintColor, clamp(interior * u_tintStrength, 0.0, 1.0));

  gl_FragColor = vec4(color, insideMask * u_opacity);
}
`;

/**
 * Morph fragment — interpolates two baked SDFs by `u_morphT` per pixel.
 *
 * Each input shape is baked into one combined SDF texture covering the
 * same `[-BOUND, BOUND]²` region; the shader samples both at the same
 * uv and lerps the distances. Because each baked field reports the
 * approximate Euclidean signed distance to its shape's boundary across
 * the whole bake region, `mix(dA, dB, t)` is itself a coherent distance
 * field whose zero-contour is a continuous geometric in-between of A
 * and B at every t (Quilez 2D distance functions, blending demos).
 *
 * Stroke conversion: a stroked SVG bakes its centerline distance, not
 * the distance to its filled tube boundary. Lerping a centerline field
 * against a fill field renders as a solid disc (the centerline's
 * negative interior is empty in fill semantics). We pre-convert each
 * stroked side to the sausage fill SDF `abs(d) - halfWidth` (the
 * Minkowski sum of the centerline with a disc of `halfWidth`) so both
 * sides of the lerp are coherent fill SDFs. Filled shapes pass through
 * unchanged (`u_aIsStroked = u_bIsStroked = 0` makes both branches a
 * no-op).
 *
 * Color is lerped from `u_colorA` (t=0) to `u_colorB` (t=1). No per-path
 * machinery applies — morph renders as a single uniform color.
 */
export const WEBGL_MORPH_FRAG = /* glsl */ `
#extension GL_OES_standard_derivatives : enable
precision highp float;

uniform vec2  u_res;
uniform float u_zoom;
uniform vec2  u_offset;
uniform float u_opacity;
uniform float u_bound;
uniform float u_morphT;
uniform vec3  u_colorA;
uniform vec3  u_colorB;
uniform float u_aIsStroked;
uniform float u_bIsStroked;
uniform float u_aHalfWidth;
uniform float u_bHalfWidth;
uniform sampler2D u_sdfA;
uniform sampler2D u_sdfB;

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  uv *= 2.0 / u_zoom;
  uv -= u_offset;

  vec2 t = clamp((uv / u_bound) * 0.5 + 0.5, 0.0, 1.0);
  float dA_raw = texture2D(u_sdfA, t).r;
  float dB_raw = texture2D(u_sdfB, t).r;

  float dA = mix(dA_raw, abs(dA_raw) - u_aHalfWidth, u_aIsStroked);
  float dB = mix(dB_raw, abs(dB_raw) - u_bHalfWidth, u_bIsStroked);
  float d = mix(dA, dB, u_morphT);

  float aa = fwidth(d) * 1.2;
  float mask = 1.0 - smoothstep(-aa, aa, d);
  vec3 color = mix(u_colorA, u_colorB, u_morphT);
  gl_FragColor = vec4(color, mask * u_opacity);
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
  //gl_FragColor = vec4(normal * 0.5 + 0.5, 0.0, insideMask);
}
`;

export const WEBGL_BAKE_BOUND = 1.2;
export const WEBGL_BAKE_SIZE = 1024;
