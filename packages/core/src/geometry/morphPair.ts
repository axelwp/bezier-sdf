import type { CubicSegment, Mark, Path } from './types';

/**
 * Cap on paths per side for the morph effect. The bake shader holds
 * `pathEnds[i]` for at most this many paths; anything past the cap is
 * concatenated into the final path so its segments still contribute to
 * the SDF (rendered as one big path's interior under the chosen fill
 * rule).
 *
 * Real-world icon morphs are typically 1–4 paths; the cap is generous
 * for arbitrary multi-subpath SVGs.
 */
export const MORPH_MAX_PATHS = 16;

export interface PreparedMorphPair {
  readonly markA: Mark;
  readonly markB: Mark;
}

/**
 * Prepare two marks for the flatten-then-bake morph pipeline. Each side
 * bakes into a single combined SDF — there's no per-path correspondence
 * between A and B, so this helper is reduced to the cap-merge step.
 *
 * If a side has more than {@link MORPH_MAX_PATHS} paths, the trailing
 * paths are merged into the last allowed path. Logged once per side per
 * init. This is a hard cap from the bake shader's `u_pathEnds` array
 * size; merging is preferable to truncation because every segment then
 * still contributes to the silhouette (just under the merged path's
 * fill rule).
 *
 * Pure / deterministic: same inputs → same outputs. Both renderer init
 * (for baking) and the React component call this with the same marks.
 */
export function prepareMorphPair(markA: Mark, markB: Mark): PreparedMorphPair {
  return {
    markA: capMerge(markA, 'A'),
    markB: capMerge(markB, 'B'),
  };
}

function capMerge(mark: Mark, label: 'A' | 'B'): Mark {
  if (mark.paths.length <= MORPH_MAX_PATHS) return mark;

  // eslint-disable-next-line no-console
  console.warn(
    `[bezier-sdf] morph effect supports up to ${MORPH_MAX_PATHS} paths per side; ` +
      `paths ${MORPH_MAX_PATHS}..${mark.paths.length - 1} of shape ${label} ` +
      `have been merged into path ${MORPH_MAX_PATHS - 1}`,
  );

  const head = mark.paths.slice(0, MORPH_MAX_PATHS - 1);
  const tail = mark.paths.slice(MORPH_MAX_PATHS - 1);
  const anchor = tail[0]!;
  const merged: CubicSegment[] = [];
  for (const p of tail) {
    for (const s of p.segments) merged.push(s);
  }
  const mergedPath: Path = {
    segments: merged,
    mode: anchor.mode,
    strokeWidth: anchor.strokeWidth,
    fillColor: anchor.fillColor,
    strokeColor: anchor.strokeColor,
    fillOpacity: anchor.fillOpacity,
    strokeOpacity: anchor.strokeOpacity,
  };
  return { paths: [...head, mergedPath], renderMode: mark.renderMode };
}
