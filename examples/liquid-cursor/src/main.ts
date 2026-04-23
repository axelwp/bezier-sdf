import { createRenderer, DEMO_MARK, type Uniforms } from '@bezier-sdf/core';

const COLOR: readonly [number, number, number] = [1, 0.23, 0.48];
const SMIN_K = 0.08;

// Distortion tuning. `cursor*` values live in normalized SDF space,
// where the baked [-1, 1] box covers the logo. The shader applies
// `d -= cursorPull / (|cursor - uv|² + cursorRadius)`, so the pull
// strength at the cursor itself is roughly `cursorPull / cursorRadius`
// — that has to exceed typical SDF distances (~0.1–0.3) to visibly
// reach out.
const PULL_HOVER = 0.012;   // rest-state pull (gentle tendril following cursor)
const RADIUS = 0.05;        // softening epsilon — smaller = sharper tendril
const POINTER_LERP = 0.5;   // smoothing factor per frame (higher = snappier)

// Ripple tuning. The shader subtracts a Gaussian ring centered on the
// click point; JS grows its radius and fades its amplitude over time.
const RIPPLE_SPEED = 2.8;    // SDF units per second (ring expansion)
const RIPPLE_DURATION = 0.9; // seconds — how long the ripple lives
const RIPPLE_AMPLITUDE = 0.08; // peak SDF deformation at the ring
const RIPPLE_DECAY = 3.5;    // exponential falloff exponent (higher = snappier)

async function main() {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  sizeCanvas(canvas);

  const { renderer, actualKind, fallbackFrom } = await createRenderer('auto', {
    canvas,
    mark: DEMO_MARK,
  });
  if (fallbackFrom) {
    console.info('[liquid-cursor] fell back to WebGL:', fallbackFrom.error.message);
  } else {
    console.info('[liquid-cursor] backend:', actualKind);
  }

  // Target cursor (from events) and smoothed cursor (what the shader sees).
  let targetX = 0, targetY = 0;
  let smoothX = 0, smoothY = 0;
  let hoverPull = 0; // 0 when cursor is off-canvas, else PULL_HOVER

  // Ring buffer of 4 concurrent ripples. Each slot tracks its own click
  // point and start time; slot is dead once (now - startMs) > duration.
  type Ripple = { x: number; y: number; startMs: number };
  const ripples: (Ripple | null)[] = [null, null, null, null];
  let nextSlot = 0;

  // Canvas pixels → SDF-space UV. Matches the transform in the sample
  // shader (both backends end up with the same SDF-space orientation).
  const eventToUv = (clientX: number, clientY: number): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * (canvas.width / rect.width);
    const py = (clientY - rect.top) * (canvas.height / rect.height);
    const m = Math.min(canvas.width, canvas.height);
    return [
      ((px - 0.5 * canvas.width) / m) * 2,   // zoom=1, offset=0
      ((0.5 * canvas.height - py) / m) * 2,
    ];
  };

  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = eventToUv(e.clientX, e.clientY);
    targetX = x; targetY = y;
    hoverPull = PULL_HOVER;
  });
  canvas.addEventListener('pointerenter', () => { hoverPull = PULL_HOVER; });
  canvas.addEventListener('pointerleave', () => { hoverPull = 0; });
  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = eventToUv(e.clientX, e.clientY);
    targetX = x; targetY = y;
    ripples[nextSlot] = { x, y, startMs: performance.now() };
    nextSlot = (nextSlot + 1) % ripples.length;
  });

  const rippleUniform = (r: Ripple | null, now: number): readonly [number, number, number, number] => {
    if (!r) return [0, 0, 0, 0];
    const age = (now - r.startMs) / 1000;
    if (age < 0 || age > RIPPLE_DURATION) return [0, 0, 0, 0];
    return [r.x, r.y, age * RIPPLE_SPEED, RIPPLE_AMPLITUDE * Math.exp(-age * RIPPLE_DECAY)];
  };

  const buildUniforms = (now: number): Uniforms => ({
    width: canvas.width,
    height: canvas.height,
    zoom: 1,
    sminK: SMIN_K,
    offsetX: 0,
    offsetY: 0,
    pathOffsets: [[0, 0], [0, 0]],
    color: COLOR,
    opacity: 1,
    cursor: [smoothX, smoothY],
    cursorPull: hoverPull,
    cursorRadius: RADIUS,
    ripples: ripples.map((r) => rippleUniform(r, now)),
  });

  const tick = (now: number) => {
    smoothX += (targetX - smoothX) * POINTER_LERP;
    smoothY += (targetY - smoothY) * POINTER_LERP;
    renderer.render(buildUniforms(now));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const onResize = () => {
    if (sizeCanvas(canvas)) renderer.render(buildUniforms(performance.now()));
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
  console.error('[liquid-cursor] init failed:', err);
});
