import { DEMO_MARK, type Mark } from '@bezier-sdf/core';
import { bambooMark, type InkMark } from './plant';
import { BAKE_BOUND, BAKE_FRAG, INK_FRAG, MAX_PATHS, VERT } from './shaders';

const BAKE_SIZE = 1024;
/** Re-baked every frame while swaying, so a quarter of the fragments. */
const SWAY_BAKE_SIZE = 512;

interface Params {
  inkLoad: number;
  wetEdge: number;
  blotch: number;
  dry: number;
  bleed: number;
  grain: number;
  granulation: number;
}

const DEFAULTS: Params = {
  inkLoad: 0.85,
  wetEdge: 0.45,
  blotch: 0.5,
  dry: 0.35,
  bleed: 0.5,
  grain: 0.6,
  granulation: 0.5,
};

const INK: readonly [number, number, number] = [0.06, 0.055, 0.06];
const PAPER: readonly [number, number, number] = [0.95, 0.91, 0.82];

type ShapeId = 'bamboo' | 'chevrons';

const CHEVRONS: InkMark = {
  mark: DEMO_MARK,
  tones: DEMO_MARK.paths.map((_, i) => (i % 2 === 0 ? 1.0 : 0.7)),
};

/** Principal axis of a path's control points: the direction the brush moved. */
function brushAngle(path: Mark['paths'][number]): number {
  let n = 0, mx = 0, my = 0;
  for (const s of path.segments) for (let i = 0; i < 8; i += 2) { mx += s[i]!; my += s[i + 1]!; n++; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const s of path.segments) {
    for (let i = 0; i < 8; i += 2) {
      const dx = s[i]! - mx, dy = s[i + 1]! - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
  }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(prog, 0, 'a_pos');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}

function main() {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 is required for the ink example');
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('EXT_color_buffer_float is required to bake the SDF');
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const bakeProg = link(gl, BAKE_FRAG);
  const inkProg = link(gl, INK_FRAG);
  const loc = (prog: WebGLProgram, name: string) => gl.getUniformLocation(prog, name);

  // Segment texture (RGBA32F, 2 texels per cubic). Reallocated only when
  // the segment count changes; sway frames update it in place.
  const segTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, segTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  let segCapacity = 0;
  let segData = new Float32Array(0);
  const ends = new Int32Array(MAX_PATHS);
  const modes = new Int32Array(MAX_PATHS);
  const halfW = new Float32Array(MAX_PATHS);
  const tone = new Float32Array(MAX_PATHS);
  const angle = new Float32Array(MAX_PATHS);

  // Baked fields: full resolution for still frames, a smaller one that
  // sway re-bakes every frame.
  const makeTarget = (size: number) => {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, size, size, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, size };
  };
  const stillTarget = makeTarget(BAKE_SIZE);
  const swayTarget = makeTarget(SWAY_BAKE_SIZE);
  let current = stillTarget;

  const bake = ({ mark, tones }: InkMark, target: typeof stillTarget) => {
    const paths = mark.paths.slice(0, MAX_PATHS);
    const segCount = paths.reduce((n, p) => n + p.segments.length, 0);
    if (segData.length !== segCount * 8) segData = new Float32Array(segCount * 8);
    let k = 0;
    paths.forEach((p, i) => {
      for (const s of p.segments) segData.set(s, (k++) * 8);
      ends[i] = k;
      modes[i] = p.mode === 'stroke' ? 1 : 0;
      halfW[i] = p.mode === 'fill' ? 0 : p.strokeWidth * 0.5;
      tone[i] = tones[i] ?? 1;
      angle[i] = brushAngle(p);
    });
    gl.bindTexture(gl.TEXTURE_2D, segTex);
    if (segCount === segCapacity) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, segCount * 2, 1, gl.RGBA, gl.FLOAT, segData);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, segCount * 2, 1, 0, gl.RGBA, gl.FLOAT, segData);
      segCapacity = segCount;
    }

    gl.useProgram(bakeProg);
    gl.uniform1i(loc(bakeProg, 'u_segments'), 0);
    gl.uniform1i(loc(bakeProg, 'u_segCount'), segCount);
    gl.uniform1f(loc(bakeProg, 'u_segmentTexWidth'), segCount * 2);
    gl.uniform1i(loc(bakeProg, 'u_fillRule'), 0);
    gl.uniform1i(loc(bakeProg, 'u_pathCount'), paths.length);
    gl.uniform1iv(loc(bakeProg, 'u_pathEnds'), ends);
    gl.uniform1iv(loc(bakeProg, 'u_pathMode'), modes);
    gl.uniform1fv(loc(bakeProg, 'u_pathHalfW'), halfW);
    gl.uniform1fv(loc(bakeProg, 'u_pathTone'), tone);
    gl.uniform1fv(loc(bakeProg, 'u_pathAngle'), angle);
    gl.uniform1f(loc(bakeProg, 'u_bound'), BAKE_BOUND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.size, target.size);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, segTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    current = target;
  };

  // ---- State -------------------------------------------------------------
  const params: Params = { ...DEFAULTS };
  let shape: ShapeId = 'bamboo';
  let seed = 0.37;
  let zoom = 1;
  let pan: [number, number] = [0, 0];
  let sway = false;
  let swayStart = performance.now();
  let frameQueued = false;

  // Only the bamboo moves; the chevrons are a static mark.
  const animating = () => sway && shape === 'bamboo';
  const markFor = (s: ShapeId, t: number): InkMark =>
    s === 'bamboo' ? bambooMark(sway ? 0.07 * Math.sin(t * 1.3) + 0.03 * Math.sin(t * 2.9) : 0) : CHEVRONS;
  const rebake = (t = 0) => bake(markFor(shape, t), animating() ? swayTarget : stillTarget);

  const draw = () => {
    gl.useProgram(inkProg);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, current.tex);
    gl.uniform1i(loc(inkProg, 'u_sdf'), 0);
    gl.uniform1f(loc(inkProg, 'u_bound'), BAKE_BOUND);
    gl.uniform2f(loc(inkProg, 'u_res'), canvas.width, canvas.height);
    gl.uniform1f(loc(inkProg, 'u_zoom'), zoom);
    gl.uniform2f(loc(inkProg, 'u_pan'), pan[0], pan[1]);
    // Integer lattice offset per reseed (see vnoise); keeps noise inputs small.
    gl.uniform2f(loc(inkProg, 'u_seedLat'), Math.floor(seed * 7919) % 4096, Math.floor(seed * 104729) % 4096);
    gl.uniform3f(loc(inkProg, 'u_ink'), ...INK);
    gl.uniform3f(loc(inkProg, 'u_paper'), ...PAPER);
    for (const [k, v] of Object.entries(params)) gl.uniform1f(loc(inkProg, `u_${k}`), v);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const frame = (now: number) => {
    frameQueued = false;
    if (animating()) rebake((now - swayStart) / 1000);
    draw();
    if (animating()) requestFrame();
  };
  const requestFrame = () => {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(frame);
  };

  // ---- Sizing ------------------------------------------------------------
  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    requestFrame();
  };
  new ResizeObserver(size).observe(canvas);

  // ---- Zoom & pan (close zoom is the point of going 2D) -----------------
  const toLogo = (cx: number, cy: number): [number, number] => {
    const r = canvas.getBoundingClientRect();
    const dpr = canvas.width / r.width;
    const px = 2.2 / Math.min(canvas.width, canvas.height) / zoom;
    return [
      ((cx - r.left) * dpr - canvas.width / 2) * px + pan[0],
      (canvas.height / 2 - (cy - r.top) * dpr) * px + pan[1],
    ];
  };
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const before = toLogo(e.clientX, e.clientY);
      zoom = Math.min(40, Math.max(0.5, zoom * Math.exp(-e.deltaY * 0.0015)));
      const after = toLogo(e.clientX, e.clientY);
      pan = [pan[0] + before[0] - after[0], pan[1] + before[1] - after[1]];
      requestFrame();
    },
    { passive: false },
  );
  let drag: [number, number] | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = toLogo(e.clientX, e.clientY);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const cur = toLogo(e.clientX, e.clientY);
    pan = [pan[0] + drag[0] - cur[0], pan[1] + drag[1] - cur[1]];
    requestFrame();
  });
  // A cancelled gesture (system swipe, palm rejection) never sends
  // pointerup; losing capture covers that and every other way out.
  const endDrag = () => (drag = null);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);
  canvas.addEventListener('dblclick', () => {
    zoom = 1;
    pan = [0, 0];
    requestFrame();
  });

  // ---- Controls ----------------------------------------------------------
  for (const key of Object.keys(DEFAULTS) as Array<keyof Params>) {
    const input = document.querySelector<HTMLInputElement>(`input[name="${key}"]`);
    if (!input) continue;
    input.value = String(params[key]);
    input.addEventListener('input', () => {
      params[key] = Number(input.value);
      requestFrame();
    });
  }
  document.querySelector<HTMLSelectElement>('#shape')!.addEventListener('change', (e) => {
    shape = (e.target as HTMLSelectElement).value as ShapeId;
    swayStart = performance.now();
    rebake();
    requestFrame();
  });
  document.querySelector<HTMLButtonElement>('#reseed')!.addEventListener('click', () => {
    seed = Math.random();
    requestFrame();
  });
  document.querySelector<HTMLInputElement>('#sway')!.addEventListener('change', (e) => {
    sway = (e.target as HTMLInputElement).checked;
    swayStart = performance.now();
    rebake();
    requestFrame();
  });

  rebake();
  size();
}

try {
  main();
} catch (err) {
  console.error('[ink] init failed:', err);
  const msg = document.getElementById('error');
  if (msg) msg.textContent = String(err instanceof Error ? err.message : err);
}
