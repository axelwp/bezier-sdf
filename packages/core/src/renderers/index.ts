export { createRenderer, type RendererKind, type CreateRendererResult } from './createRenderer';
export { WebGLRenderer } from './WebGLRenderer';
export { WebGPURenderer } from './WebGPURenderer';
export type { Renderer, RendererInitOptions, Uniforms } from './types';
export { MAX_PATHS } from '../shaders/webgl';
/**
 * GLSL ES 1.00 snippet declaring the segment/path uniforms and
 * `float sceneSDF(vec2 p, out int winningPathIdx)` — the exact distance
 * estimator the WebGL bake uses. Exposed so custom bake shaders (see
 * examples/ink) evaluate the same field, stroke mode included, instead of
 * keeping a copy that drifts. Under `#version 300 es`, define
 * `texture2D` as `texture` before including it.
 */
export { SDF_BODY as WEBGL_SDF_BODY } from '../shaders/webgl';
