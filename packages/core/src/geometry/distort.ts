import type { CubicSegment, Mark, Path } from './types';

/**
 * Geometry-level distortion. A field returns a displacement vector for
 * any point in logo space; consumers apply it to control points to bend
 * the underlying curves before re-baking.
 *
 * This sits one level below the renderer: it doesn't know about the SDF,
 * cursors, or time. Effects construct concrete fields and pass them to
 * {@link distortMark}, then ask the renderer to re-bake the result.
 *
 * Why points-not-fields: distorting the sampled SDF (`d -= falloff(uv)`)
 * is fast but only behaves for filled paths. A 1D stroke level set
 * blooms into amoeba blobs the moment you scalar-shift it. Bending the
 * underlying curves and re-baking gives faithful behavior for both fill
 * and stroke at the cost of one bake per frame.
 *
 * Fields compose by summing displacements — see {@link composeFields}.
 */
export interface DistortionField {
  /** Displacement to apply to a point in logo-space coordinates. */
  displace(x: number, y: number): readonly [number, number];
}

/** Identity field — leaves geometry unchanged. */
export const IDENTITY_FIELD: DistortionField = {
  displace: () => [0, 0],
};

/**
 * Sum the displacements of two or more fields. Order doesn't matter
 * (vector addition is commutative). Returns a field; doesn't mutate.
 */
export function composeFields(...fields: readonly DistortionField[]): DistortionField {
  if (fields.length === 0) return IDENTITY_FIELD;
  if (fields.length === 1) return fields[0]!;
  return {
    displace(x, y) {
      let dx = 0, dy = 0;
      for (const f of fields) {
        const [fx, fy] = f.displace(x, y);
        dx += fx; dy += fy;
      }
      return [dx, dy];
    },
  };
}

/**
 * Apply a field's displacement to all four control points of every cubic
 * segment in `path`. Returns a new {@link Path} with the same paint
 * metadata. Pure function — `path` is not modified.
 */
export function distortPath(path: Path, field: DistortionField): Path {
  const segs: CubicSegment[] = new Array(path.segments.length);
  for (let i = 0; i < path.segments.length; i++) {
    const s = path.segments[i]!;
    const [d0x, d0y] = field.displace(s[0], s[1]);
    const [d1x, d1y] = field.displace(s[2], s[3]);
    const [d2x, d2y] = field.displace(s[4], s[5]);
    const [d3x, d3y] = field.displace(s[6], s[7]);
    segs[i] = [
      s[0] + d0x, s[1] + d0y,
      s[2] + d1x, s[3] + d1y,
      s[4] + d2x, s[5] + d2y,
      s[6] + d3x, s[7] + d3y,
    ];
  }
  return { ...path, segments: segs };
}

/** {@link distortPath} lifted over every path in a {@link Mark}. */
export function distortMark(mark: Mark, field: DistortionField): Mark {
  return { paths: mark.paths.map((p) => distortPath(p, field)) };
}

/**
 * Gaussian radial pull toward `cursor`. Magnitude at point `p`:
 *
 *   pull × exp(-|p - cursor|² / (2 × radius²))
 *
 * — applied in the direction `cursor - p` (unit vector).
 *
 * Why Gaussian instead of inverse-square: at large `r` the Gaussian
 * decays to effectively zero (≈1% at `3·radius`, ≈0 at `4·radius`),
 * which means `radius` is a real spatial parameter and far-side
 * control points stay put. Inverse-square decays slowly enough that
 * cranking pull to get reactive near-cursor response also drags the
 * far side, perceptually turning local pull into global drift.
 *
 * Bounded peak (= `pull`) at `r = 0`, smooth derivatives — no
 * singularity, no twitch near the cursor. `pull = 0` returns identity.
 * All values are in logo space — the same coordinate system as
 * {@link CubicSegment}.
 */
export function cursorField(params: {
  cursor: readonly [number, number];
  pull: number;
  radius: number;
}): DistortionField {
  const { cursor, pull, radius } = params;
  if (pull === 0) return IDENTITY_FIELD;
  const cx = cursor[0], cy = cursor[1];
  const inv2sigma2 = 1 / (2 * radius * radius);
  return {
    displace(x, y) {
      const dx = cx - x;
      const dy = cy - y;
      const r2 = dx * dx + dy * dy;
      const falloff = Math.exp(-r2 * inv2sigma2);
      // 1e-6 guard: at the cursor itself, length is 0 and direction is
      // undefined — the displacement should fade to zero too, which the
      // (dx/len)*falloff product does (falloff is bounded so the limit
      // is well-defined; the epsilon just keeps division finite).
      const len = Math.sqrt(r2) + 1e-6;
      const m = pull * falloff / len;
      return [dx * m, dy * m];
    },
  };
}
