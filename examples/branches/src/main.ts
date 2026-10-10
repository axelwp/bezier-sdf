import { BranchRenderer, type TaperedBranch } from '@bezier-sdf/core';

/**
 * A procedural tree, rebuilt from scratch every frame and drawn by the
 * live branch renderer. Growth and wind both change the geometry each
 * frame; nothing is baked. Scroll to zoom (edges stay exact), drag to
 * pan, click to regrow.
 */

const INK: readonly [number, number, number] = [0.1, 0.09, 0.08];
const MAX_DEPTH = 9;
const GROW_MS = 6000;

interface Seg {
  /** Child segments, generated once per seed. */
  children: Seg[];
  depth: number;
  /** Turn relative to the parent's tip direction (radians). */
  turn: number;
  /** Signed bend of the quadratic control point, as a fraction of length. */
  bend: number;
  /** Length relative to the parent. */
  scale: number;
  /** Phase for the wind sway. */
  phase: number;
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Topology and per-branch randomness; fixed for a given seed. */
function makeTopology(seed: number): Seg {
  const r = rng(seed);
  const grow = (depth: number, turn: number, scale: number): Seg => {
    const seg: Seg = { children: [], depth, turn, scale, bend: (r() - 0.5) * 0.5, phase: r() * 6.28 };
    if (depth < MAX_DEPTH) {
      const n = r() < 0.25 && depth > 1 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const side = n === 2 ? (i === 0 ? -1 : 1) : i - 1;
        seg.children.push(grow(depth + 1, side * (0.3 + r() * 0.35) + (r() - 0.5) * 0.2, 0.66 + r() * 0.14));
      }
    }
    return seg;
  };
  return grow(0, 0, 1);
}

/** Lay the topology out for one frame: `t` is overall growth in [0, 1]. */
function layout(root: Seg, t: number, time: number, out: TaperedBranch[]): void {
  out.length = 0;
  const visit = (seg: Seg, x: number, y: number, angle: number, len: number, r0: number) => {
    const g = Math.min(1, Math.max(0, t * (MAX_DEPTH + 1) - seg.depth));
    if (g <= 0) return;
    const sway = Math.sin(time * 0.0011 + seg.phase) * 0.025 * seg.depth;
    const a = angle + seg.turn + sway;
    const L = len * seg.scale;
    const dx = Math.cos(a), dy = Math.sin(a);
    const x2 = x + dx * L, y2 = y + dy * L;
    const b = seg.bend * L;
    const p1: [number, number] = [(x + x2) / 2 - dy * b, (y + y2) / 2 + dx * b];
    const r1 = r0 * 0.66;
    out.push({ p0: [x, y], p1, p2: [x2, y2], r0, r1, growth: g });
    if (g < 1) return;
    // Children leave along the curve's end tangent so joints read as one stroke.
    const ta = Math.atan2(y2 - p1[1], x2 - p1[0]);
    for (const c of seg.children) visit(c, x2, y2, ta, L, r1);
  };
  visit(root, 0, -0.95, Math.PI / 2, 0.36, 0.04);
}

async function main() {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const hud = document.getElementById('hud')!;
  sizeCanvas(canvas);

  const renderer = new BranchRenderer();
  await renderer.init({ canvas });

  let topology = makeTopology(3);
  let start = performance.now();
  let zoom = 1, offsetX = 0, offsetY = 0;
  const branches: TaperedBranch[] = [];
  let frames = 0, fpsAt = performance.now(), fps = 0;

  const tick = (now: number) => {
    sizeCanvas(canvas);
    const t = Math.min(1, (now - start) / GROW_MS);
    layout(topology, t, now, branches);
    renderer.setBranches(branches);
    renderer.render({
      width: canvas.width, height: canvas.height,
      zoom, offsetX, offsetY,
      color: INK, opacity: 1,
    });
    frames++;
    if (now - fpsAt > 500) { fps = (frames * 1000) / (now - fpsAt); frames = 0; fpsAt = now; }
    hud.textContent = `${branches.length} branches · ${fps.toFixed(0)} fps · zoom ${zoom.toFixed(1)}× · ${renderer.distanceTarget} target`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dpr = canvas.width / canvas.clientWidth;
    const s = 2 / (zoom * Math.min(canvas.width, canvas.height));
    // World point under the cursor stays put while zooming.
    const wx = (e.offsetX * dpr - canvas.width / 2) * s - offsetX;
    const wy = (canvas.height / 2 - e.offsetY * dpr) * s - offsetY;
    const nz = Math.min(400, Math.max(0.5, zoom * Math.exp(-e.deltaY * 0.0015)));
    const ns = 2 / (nz * Math.min(canvas.width, canvas.height));
    offsetX = (e.offsetX * dpr - canvas.width / 2) * ns - wx;
    offsetY = (canvas.height / 2 - e.offsetY * dpr) * ns - wy;
    zoom = nz;
  }, { passive: false });

  let drag: { x: number; y: number; moved: boolean } | null = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dpr = canvas.width / canvas.clientWidth;
    const s = (2 / (zoom * Math.min(canvas.width, canvas.height))) * dpr;
    offsetX += (e.clientX - drag.x) * s;
    offsetY -= (e.clientY - drag.y) * s;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 0) drag.moved = true;
    drag.x = e.clientX; drag.y = e.clientY;
  });
  window.addEventListener('pointerup', () => {
    if (drag && !drag.moved) {
      topology = makeTopology((Math.random() * 2 ** 31) | 0);
      start = performance.now();
    }
    drag = null;
  });
}

function sizeCanvas(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(window.innerWidth * dpr));
  const h = Math.max(1, Math.floor(window.innerHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

main().catch((err) => {
  console.error('[branches] init failed:', err);
  document.body.textContent = `init failed: ${err instanceof Error ? err.message : String(err)}`;
});
