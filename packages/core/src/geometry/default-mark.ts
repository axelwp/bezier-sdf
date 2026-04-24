import { type CubicSegment, type Mark, type Path, makePath } from './types';

/**
 * Default demo mark: two rounded triangles facing inward (`▶ ◀`).
 *
 * Designed to exercise every feature of the renderer in a small space:
 *   - Two independent sub-paths → two baked SDF textures → per-path
 *     animation offsets for the split-morph intro.
 *   - Six cubics per path (three straight edges alternating with three
 *     corner-fillet arcs). Small enough to grok, large enough to see the
 *     bake-and-sample workflow clearly.
 *
 * Replace with your own traced logo using {@link parseSvgDocument} /
 * {@link parseSvgPath} or by hand-writing segments in this flat 8-float
 * layout.
 */
const LEFT_CHEVRON_SEGS: readonly CubicSegment[] = [
  [-0.85663,  0.61107, -0.66554,  0.43591, -0.47446,  0.26075, -0.28337,  0.08559],
  [-0.28337,  0.08559, -0.23180,  0.03832, -0.23180, -0.03832, -0.28337, -0.08559],
  [-0.28337, -0.08559, -0.47446, -0.26075, -0.66554, -0.43591, -0.85663, -0.61107],
  [-0.85663, -0.61107, -0.90820, -0.65835, -0.95000, -0.63996, -0.95000, -0.57000],
  [-0.95000, -0.57000, -0.95000, -0.19000, -0.95000,  0.19000, -0.95000,  0.57000],
  [-0.95000,  0.57000, -0.95000,  0.63996, -0.90820,  0.65835, -0.85663,  0.61107],
] as const;

const RIGHT_CHEVRON_SEGS: readonly CubicSegment[] = [
  [ 0.28337, -0.08559,  0.47446, -0.26075,  0.66554, -0.43591,  0.85663, -0.61107],
  [ 0.85663, -0.61107,  0.90820, -0.65835,  0.95000, -0.63996,  0.95000, -0.57000],
  [ 0.95000, -0.57000,  0.95000, -0.19000,  0.95000,  0.19000,  0.95000,  0.57000],
  [ 0.95000,  0.57000,  0.95000,  0.63996,  0.90820,  0.65835,  0.85663,  0.61107],
  [ 0.85663,  0.61107,  0.66554,  0.43591,  0.47446,  0.26075,  0.28337,  0.08559],
  [ 0.28337,  0.08559,  0.23180,  0.03832,  0.23180, -0.03832,  0.28337, -0.08559],
] as const;

export const LEFT_CHEVRON: Path = makePath(LEFT_CHEVRON_SEGS);
export const RIGHT_CHEVRON: Path = makePath(RIGHT_CHEVRON_SEGS);

/**
 * The default demo mark, combining both chevrons. Opts into
 * `'legacy-smin'` so the reveal effect keeps its signature liquid-metal
 * fusion animation — the two chevrons are meant to morph through a
 * single-silhouette intermediate state, not stay visually separate.
 */
export const DEMO_MARK: Mark = {
  paths: [LEFT_CHEVRON, RIGHT_CHEVRON],
  renderMode: 'legacy-smin',
};
