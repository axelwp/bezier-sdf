import { makePath, type CubicSegment, type Mark, type Path } from '@bezier-sdf/core';

/**
 * Procedural bamboo spray in normalized logo space (|x|, |y| ≲ 1, +y up).
 *
 * Every element is a closed fill outline built from a handful of cubics,
 * the way a painter builds bamboo from discrete strokes: one stroke per
 * internode (gaps left at the nodes), a tapered flick per twig, and two
 * curves per leaf. `sway` (radians-ish, ~±0.1) bends twigs and leaves so
 * the example can show the ink holding up while the geometry animates.
 */

type V = readonly [number, number];

const rot = (p: V, a: number): V => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
};
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1]];

/** Map a list of local-frame points through bend → rotate → translate. */
function place(pts: V[], origin: V, angle: number, bend: number, len: number): V[] {
  return pts.map((p) => {
    const u = p[0] / len;
    // Quadratic bend perpendicular to the long axis: tip droops by `bend*len`.
    const bent: V = [p[0], p[1] + bend * len * u * u];
    return add(origin, rot(bent, angle));
  });
}

/** Two cubics (out along one side, back along the other) → one closed path. */
function closedFromPoints(q: V[]): Path {
  const seg = (a: V, b: V, c: V, d: V): CubicSegment => [a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]];
  const segs: CubicSegment[] = [];
  for (let i = 0; i + 3 < q.length; i += 3) segs.push(seg(q[i]!, q[i + 1]!, q[i + 2]!, q[i + 3]!));
  return makePath(segs);
}

function leaf(origin: V, angle: number, len: number, width: number, bend: number): Path {
  const L = len;
  const W = width;
  // Lanceolate: pinched base, widest around 30% of the length, long sharp tip.
  const local: V[] = [
    [0, 0],
    [L * 0.18, W * 1.25], [L * 0.62, W * 0.75], [L, 0],
    [L * 0.62, -W * 0.55], [L * 0.18, -W * 1.05], [0, 0],
  ];
  return closedFromPoints(place(local, origin, angle, bend, L));
}

function twig(origin: V, angle: number, len: number, width: number, bend: number): Path {
  const L = len;
  const W = width;
  const local: V[] = [
    [0, W],
    [L * 0.35, W * 0.8], [L * 0.75, W * 0.35], [L, 0],
    [L * 0.75, -W * 0.35], [L * 0.35, -W * 0.8], [0, -W],
    [-W * 0.3, -W * 0.5], [-W * 0.3, W * 0.5], [0, W],
  ];
  return closedFromPoints(place(local, origin, angle, bend, L));
}

/** One internode of the culm: slightly waisted sides, flared ends. */
function internode(x0: number, y0: number, y1: number, hw: number, lean: number): Path {
  const xa = x0 + lean * y0;
  const xb = x0 + lean * y1;
  const h = y1 - y0;
  const flare = hw * 0.18;
  const waist = hw * 0.12;
  const q: V[] = [
    // bottom edge, left → right (slight upward smile)
    [xa - hw - flare, y0], [xa - hw * 0.3, y0 + h * 0.03], [xa + hw * 0.3, y0 + h * 0.03], [xa + hw + flare, y0],
    // right side, bottom → top (waisted)
    [xa + hw - waist, y0 + h * 0.35], [xb + hw - waist, y0 + h * 0.65], [xb + hw + flare, y1],
    // top edge, right → left
    [xb + hw * 0.3, y1 - h * 0.025], [xb - hw * 0.3, y1 - h * 0.025], [xb - hw - flare, y1],
    // left side, top → bottom
    [xb - hw + waist, y0 + h * 0.65], [xa - hw + waist, y0 + h * 0.35], [xa - hw - flare, y0],
  ];
  return closedFromPoints(q);
}

/** A mark plus each path's brush load (ink tone), index-aligned. */
export interface InkMark {
  mark: Mark;
  tones: number[];
}

export function bambooMark(sway = 0): InkMark {
  const paths: Path[] = [];
  const tones: number[] = [];
  // Brush load travels with each path, so reordering or adding strokes
  // can't hand leaves the culm's tone. Culm is painted lighter than leaves.
  const stroke = (p: Path, tone: number) => {
    paths.push(p);
    tones.push(tone);
  };
  const lean = 0.12;
  const x0 = -0.2;
  const hw = 0.055;
  const gap = 0.022;
  const nodes = [-1.0, -0.55, -0.14, 0.22, 0.55, 0.82];
  for (let i = 0; i + 1 < nodes.length; i++) {
    stroke(internode(x0, nodes[i]! + gap, nodes[i + 1]! - gap, hw * (1 - i * 0.07), lean), 0.62);
  }
  const nodeAt = (i: number): V => [x0 + lean * nodes[i]!, nodes[i]!];

  // Twig from the third node, sweeping right and up.
  const t1o = add(nodeAt(2), [hw * 0.6, 0]);
  const t1a = 0.55 + sway * 0.4;
  const t1b = -0.05 - sway * 0.2;
  stroke(twig(t1o, t1a, 0.62, 0.012, t1b), 0.8);
  // Points along the twig's centreline, using the same bend as the twig
  // itself so leaves stay attached while it sways.
  const t1 = (u: number): V => add(t1o, rot([0.62 * u, t1b * 0.62 * u * u], t1a));

  // Twig from the fourth node, sweeping left.
  const t2o = add(nodeAt(4), [-hw * 0.6, 0]);
  const t2a = Math.PI - 0.7 + sway * 0.3;
  const t2b = 0.06 + sway * 0.2;
  stroke(twig(t2o, t2a, 0.42, 0.010, t2b), 0.8);
  const t2 = (u: number): V => add(t2o, rot([0.42 * u, t2b * 0.42 * u * u], t2a));

  // Leaf clusters. Each: [anchor, angle, length, width, bend].
  const s = sway;
  const leaves: Array<[V, number, number, number, number]> = [
    [t1(1.0), 0.15 + s, 0.62, 0.075, -0.16],
    [t1(1.0), -0.45 + s, 0.55, 0.068, -0.12],
    [t1(0.97), -1.05 + s, 0.48, 0.062, 0.14],
    [t1(0.62), -0.25 + s * 0.8, 0.5, 0.066, -0.18],
    [t1(0.6), -1.25 + s * 0.8, 0.42, 0.056, 0.1],
    [t2(1.0), Math.PI + 0.2 + s, 0.5, 0.066, 0.16],
    [t2(1.0), Math.PI - 0.35 + s, 0.44, 0.06, 0.12],
    [t2(0.98), Math.PI + 0.75 + s, 0.4, 0.055, -0.1],
    [nodeAt(5), 0.85 + s * 0.6, 0.3, 0.045, -0.2],
    [nodeAt(5), 2.35 + s * 0.6, 0.28, 0.042, 0.18],
  ];
  leaves.forEach(([o, a, l, w, b], i) => stroke(leaf(o, a, l, w, b), 0.92 + 0.08 * Math.sin((i + 7) * 2.7)));

  return { mark: { paths, renderMode: 'legacy-smin' }, tones };
}
