/**
 * GLSL ES 3.00 shaders for {@link BranchRenderer} — tapered quadratic
 * Bezier branches evaluated analytically every frame, no bake.
 *
 * Architecture:
 *   1. DISTANCE pass — one instanced quad per branch. The vertex shader
 *      clips the branch at its growth parameter (exact de Casteljau
 *      split) and covers only the clipped curve's chord-aligned bounding
 *      box, padded by the taper radius and an AA margin. That box is the
 *      culling: a fragment only ever evaluates the handful of branches
 *      whose boxes overlap it, instead of every branch in the scene. The
 *      fragment shader writes the branch's signed distance and the
 *      target blends with MIN, so the target ends up holding the exact
 *      hard union of all branches as a distance field.
 *   2. COMPOSITE pass — one fullscreen triangle that turns the distance
 *      field into anti-aliased coverage and paints it. Having the full
 *      field here (not just coverage) is what later ink effects — edge
 *      darkening, bleed, dry-brush breakup — will read from.
 *
 * Coordinates match the other renderers: logo space, `+y` up, the
 * shorter canvas side spans `[-1, 1]` at zoom 1, and `u_offset` is
 * subtracted from the pixel's world position.
 */

/** Shared world ↔ clip mapping. `u_res` is the canvas size in pixels. */
const VIEW = /* glsl */ `
uniform vec2  u_res;
uniform float u_zoom;
uniform vec2  u_offset;
`;

export const BRANCH_DIST_VERT = /* glsl */ `#version 300 es
precision highp float;
${VIEW}
/** World-space AA margin added around every box (≈ 2 px). */
uniform float u_pad;

// Per-vertex: unit-square corner in [0, 1]².
layout(location = 0) in vec2 a_corner;
// Per-instance: (p0, p1), (p2, r0, r1), growth.
layout(location = 1) in vec4 a_p01;
layout(location = 2) in vec4 a_p2r;
layout(location = 3) in float a_growth;

out vec2 v_world;
flat out vec2 v_A;
flat out vec2 v_B;
flat out vec2 v_C;
flat out vec2 v_r;

void main() {
  float g = clamp(a_growth, 0.0, 1.0);
  if (g <= 0.0) {
    // Not grown yet: collapse to a degenerate (culled) primitive.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 P0 = a_p01.xy, P1 = a_p01.zw, P2 = a_p2r.xy;
  // De Casteljau split at g: [0, g] is itself an exact quadratic.
  vec2 Q1 = mix(P0, P1, g);
  vec2 Q2 = mix(Q1, mix(P1, P2, g), g);
  float r0 = a_p2r.z;
  float r1 = mix(a_p2r.z, a_p2r.w, g);

  // Chord-aligned box around the control hull (which contains the
  // curve), padded by the larger radius plus the AA margin.
  vec2 u = Q2 - P0;
  float len = length(u);
  u = len > 1e-9 ? u / len : vec2(1.0, 0.0);
  vec2 v = vec2(-u.y, u.x);
  vec3 pu = vec3(dot(P0, u), dot(Q1, u), dot(Q2, u));
  vec3 pv = vec3(dot(P0, v), dot(Q1, v), dot(Q2, v));
  float r = max(r0, r1) + u_pad;
  vec2 lo = vec2(min(pu.x, min(pu.y, pu.z)), min(pv.x, min(pv.y, pv.z))) - r;
  vec2 hi = vec2(max(pu.x, max(pu.y, pu.z)), max(pv.x, max(pv.y, pv.z))) + r;
  vec2 box = mix(lo, hi, a_corner);
  vec2 world = box.x * u + box.y * v;

  v_world = world;
  v_A = P0; v_B = Q1; v_C = Q2;
  v_r = vec2(r0, r1);
  gl_Position = vec4((world + u_offset) * u_zoom * min(u_res.x, u_res.y) / u_res, 0.0, 1.0);
}
`;

export const BRANCH_DIST_FRAG = /* glsl */ `#version 300 es
precision highp float;

/** 0: write raw distance (float target). 1: write distance encoded
 *  into [0, 1] over ±u_band (RGBA8 fallback target). */
uniform int   u_encode;
uniform float u_band;

in vec2 v_world;
flat in vec2 v_A;
flat in vec2 v_B;
flat in vec2 v_C;
flat in vec2 v_r;

out vec4 o_dist;

float dot2(vec2 x) { return dot(x, x); }

// Closed-form distance to a quadratic Bezier and the closest-point
// parameter (after Inigo Quilez, sdBezier). Mirrors quadraticDistance()
// in geometry/branch.ts.
vec2 quadDistance(vec2 pos, vec2 A, vec2 B, vec2 C) {
  vec2 a = B - A;
  vec2 b = A - 2.0 * B + C;
  vec2 d = A - pos;
  float bb = dot(b, b);
  float aa = dot(a, a);
  if (bb <= 1e-5 * aa || bb < 1e-20) {
    vec2 e = C - A;
    float ee = dot(e, e);
    float t = ee > 0.0 ? clamp(-dot(d, e) / ee, 0.0, 1.0) : 0.0;
    return vec2(length(d + e * t), t);
  }
  vec2 c = 2.0 * a;
  float kk = 1.0 / bb;
  float kx = kk * dot(a, b);
  float ky = kk * (2.0 * aa + dot(d, b)) / 3.0;
  float kz = kk * dot(d, a);
  float p = ky - kx * kx;
  float q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
  float h = q * q + 4.0 * p * p * p;
  if (h >= 0.0) {
    h = sqrt(h);
    vec2 x = (vec2(h, -h) - q) / 2.0;
    vec2 uv = sign(x) * pow(abs(x), vec2(1.0 / 3.0));
    float t = clamp(uv.x + uv.y - kx, 0.0, 1.0);
    return vec2(sqrt(dot2(d + (c + b * t) * t)), t);
  }
  float z = sqrt(-p);
  float ang = acos(q / (p * z * 2.0)) / 3.0;
  float m = cos(ang);
  float n = sin(ang) * 1.732050808;
  vec2 t = clamp(vec2(m + m, -n - m) * z - kx, 0.0, 1.0);
  float d1 = dot2(d + (c + b * t.x) * t.x);
  float d2 = dot2(d + (c + b * t.y) * t.y);
  return d1 < d2 ? vec2(sqrt(d1), t.x) : vec2(sqrt(d2), t.y);
}

void main() {
  vec2 dt = quadDistance(v_world, v_A, v_B, v_C);
  float sd = dt.x - mix(v_r.x, v_r.y, dt.y);
  float outD = u_encode == 1 ? clamp(0.5 + 0.5 * sd / u_band, 0.0, 1.0) : sd;
  o_dist = vec4(outD, 0.0, 0.0, 1.0);
}
`;

export const BRANCH_COMPOSITE_VERT = /* glsl */ `#version 300 es
void main() {
  // Fullscreen triangle from the vertex id; no buffer needed.
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export const BRANCH_COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_dist;
uniform int   u_encode;
uniform float u_band;
/** World units per pixel. */
uniform float u_px;
uniform vec3  u_color;
uniform float u_opacity;

out vec4 o_color;

void main() {
  float d = texelFetch(u_dist, ivec2(gl_FragCoord.xy), 0).r;
  if (u_encode == 1) d = (d - 0.5) * 2.0 * u_band;
  float cov = clamp(0.5 - d / u_px, 0.0, 1.0);
  o_color = vec4(u_color, cov * u_opacity);
}
`;
