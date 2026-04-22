/**
 * @bezier-sdf/core
 *
 * Framework-agnostic GPU signed-distance-field rendering of cubic Bezier
 * curves. Trace a logo in Inkscape or Figma, parse the SVG, and render
 * it as a crisp anti-aliased silhouette at any zoom — with WebGPU on
 * supported browsers and WebGL everywhere else.
 *
 * Submodule entry points (use these for smaller bundles):
 *   @bezier-sdf/core/geometry  — types, parseSvgPath, sampling helpers
 *   @bezier-sdf/core/renderers — createRenderer and backend classes
 *   @bezier-sdf/core/canvas    — Canvas 2D helpers for mask-based effects
 *
 * This top-level module re-exports everything for convenience.
 */

export * from './geometry';
export * from './renderers';
export * from './canvas';
