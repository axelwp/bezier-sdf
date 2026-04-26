import {
  createRenderer,
  DEMO_MARK,
  makePath,
  type CubicSegment,
  type Mark,
  type Uniforms,
} from '@bezier-sdf/core';

const COLOR_A: readonly [number, number, number] = [1.0, 0.227, 0.478]; // #ff3a7a
const COLOR_B: readonly [number, number, number] = [0.063, 0.784, 1.0]; // #10c8ff

// Critically-damped exponential approach toward the hover target. rate=15
// reaches ~95% of the new target in ~200 ms; framerate-independent because
// the per-frame step is `1 - exp(-rate*dt)`.
const RATE = 15;

/** Cubic segment for a straight line from `a` to `b`. */
function lineSeg(
  a: readonly [number, number],
  b: readonly [number, number],
): CubicSegment {
  const cx1 = a[0] + (b[0] - a[0]) / 3;
  const cy1 = a[1] + (b[1] - a[1]) / 3;
  const cx2 = a[0] + (2 * (b[0] - a[0])) / 3;
  const cy2 = a[1] + (2 * (b[1] - a[1])) / 3;
  return [a[0], a[1], cx1, cy1, cx2, cy2, b[0], b[1]];
}

/** Build a closed square mark centered at the origin with half-side `s`. */
function squareMark(s: number): Mark {
  const tl: readonly [number, number] = [-s, s];
  const tr: readonly [number, number] = [s, s];
  const br: readonly [number, number] = [s, -s];
  const bl: readonly [number, number] = [-s, -s];
  return {
    paths: [makePath([lineSeg(tl, tr), lineSeg(tr, br), lineSeg(br, bl), lineSeg(bl, tl)])],
    renderMode: 'legacy-smin',
  };
}

async function main() {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  sizeCanvas(canvas);

  const SHAPE_A = DEMO_MARK;
  const SHAPE_B = squareMark(0.62);

  const { renderer, actualKind, fallbackFrom } = await createRenderer('auto', {
    canvas,
    mark: SHAPE_A,
    morphTo: SHAPE_B,
  });
  if (fallbackFrom) {
    console.info('[morph] fell back to WebGL:', fallbackFrom.error.message);
  } else {
    console.info('[morph] backend:', actualKind);
  }

  const reducedMotion =
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  let target = 0;
  let t = 0;
  let lastNow: number | null = null;
  let animating = false;

  const baseUniforms = (mt: number): Uniforms => ({
    width: canvas.width,
    height: canvas.height,
    zoom: 1,
    sminK: 0.005,
    offsetX: 0,
    offsetY: 0,
    pathOffsets: [],
    color: [0, 0, 0],
    opacity: 1,
    morph: { t: mt, colorA: COLOR_A, colorB: COLOR_B },
  });

  const tick = (now: number) => {
    if (lastNow === null) lastNow = now;
    const dt = Math.max(0, (now - lastNow) / 1000);
    lastNow = now;
    const k = 1 - Math.exp(-RATE * dt);
    t += (target - t) * k;

    renderer.render(baseUniforms(t));

    if (Math.abs(target - t) > 1e-3) {
      requestAnimationFrame(tick);
    } else {
      // Snap exactly to the target so the next idle render is precise.
      t = target;
      renderer.render(baseUniforms(t));
      animating = false;
      lastNow = null;
    }
  };

  const startLoop = () => {
    if (animating) return;
    animating = true;
    requestAnimationFrame(tick);
  };

  if (!reducedMotion) {
    canvas.addEventListener('pointerenter', () => {
      target = 1;
      // Reset dt baseline — otherwise the first hover snaps because
      // `lastNow` has been accumulating since the last animation idled.
      lastNow = null;
      startLoop();
    });
    canvas.addEventListener('pointerleave', () => {
      target = 0;
      lastNow = null;
      startLoop();
    });
    // Touch devices have no hover — tap to toggle endpoints.
    canvas.addEventListener('pointerdown', () => {
      target = target < 0.5 ? 1 : 0;
      lastNow = null;
      startLoop();
    });
  }

  // Initial frame at t=0 (shape A).
  renderer.render(baseUniforms(t));

  const onResize = () => {
    if (sizeCanvas(canvas)) renderer.render(baseUniforms(t));
  };
  window.addEventListener('resize', onResize);
  let dprMql = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
  const onDprChange = () => {
    onResize();
    dprMql?.removeEventListener('change', onDprChange);
    dprMql = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprMql?.addEventListener('change', onDprChange);
  };
  dprMql?.addEventListener('change', onDprChange);
}

function sizeCanvas(canvas: HTMLCanvasElement): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(window.innerWidth * dpr));
  const h = Math.max(1, Math.floor(window.innerHeight * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

main().catch((err) => {
  console.error('[morph] init failed:', err);
});
