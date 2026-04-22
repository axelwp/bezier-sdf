import { createRenderer, DEMO_MARK, type Uniforms } from '@bezier-sdf/core';

const COLOR: readonly [number, number, number] = [1, 0.23, 0.48];
const SMIN_K = 0.08;
const START_OFFSET = 0.5;
const DELAY_MS = 100;
const DURATION_MS = 1400;

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

async function main() {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  sizeCanvas(canvas);

  const { renderer, actualKind, fallbackFrom } = await createRenderer('auto', {
    canvas,
    mark: DEMO_MARK,
  });
  if (fallbackFrom) {
    console.info('[reveal] fell back to WebGL:', fallbackFrom.error.message);
  } else {
    console.info('[reveal] backend:', actualKind);
  }

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const baseUniforms = (split: number): Uniforms => ({
    width: canvas.width,
    height: canvas.height,
    zoom: 1,
    sminK: SMIN_K,
    offsetX: 0,
    offsetY: 0,
    pathOffsets: [
      [ START_OFFSET * split, 0],
      [-START_OFFSET * split, 0],
    ],
    color: COLOR,
    opacity: 1,
  });

  let currentSplit = reducedMotion ? 0 : 1;
  let animating = !reducedMotion;
  const start = performance.now() + DELAY_MS;

  const tick = (now: number) => {
    const elapsed = now - start;
    if (elapsed <= 0) {
      currentSplit = 1;
    } else if (elapsed >= DURATION_MS) {
      currentSplit = 0;
      animating = false;
    } else {
      currentSplit = 1 - easeOutCubic(elapsed / DURATION_MS);
    }
    renderer.render(baseUniforms(currentSplit));
    if (animating) requestAnimationFrame(tick);
  };

  const onResize = () => {
    if (sizeCanvas(canvas)) renderer.render(baseUniforms(currentSplit));
  };
  window.addEventListener('resize', onResize);
  // DPR changes (monitor hop, browser zoom on some engines) don't always
  // fire 'resize' — watch the resolution media query too.
  let dprMql = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
  const onDprChange = () => {
    onResize();
    dprMql?.removeEventListener('change', onDprChange);
    dprMql = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprMql?.addEventListener('change', onDprChange);
  };
  dprMql?.addEventListener('change', onDprChange);

  if (reducedMotion) {
    renderer.render(baseUniforms(0));
  } else {
    requestAnimationFrame(tick);
  }
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
  console.error('[reveal] init failed:', err);
});
