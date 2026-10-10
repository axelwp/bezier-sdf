import {
  BRANCH_BOX_STRIDE,
  BRANCH_STRIDE,
  branchBoxes,
  packBranches,
  type TaperedBranch,
} from '../geometry/branch';
import {
  BRANCH_COMPOSITE_FRAG,
  BRANCH_COMPOSITE_VERT,
  BRANCH_DIST_FRAG,
  BRANCH_DIST_VERT,
} from '../shaders/branch';
import { link } from './glProgram';

export interface BranchRendererInitOptions {
  canvas: HTMLCanvasElement;
  /** Initial branch capacity; the instance buffer grows on demand. */
  capacity?: number;
}

export interface BranchUniforms {
  width: number;
  height: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
  color: readonly [number, number, number];
  opacity: number;
}

/** AA margin around each branch's box, in pixels. */
const PAD_PX = 2;
/** Distance band (in pixels) the RGBA8 fallback can represent. */
const ENCODE_BAND_PX = 8;
/** "Far away" clear value for the float distance target. */
const FAR = 1e4;

/** Distance target formats, best first. */
type TargetFormat = 'r16f' | 'rgba16f' | 'rgba8';

/**
 * Live renderer for tapered quadratic Bezier branches.
 *
 * Unlike {@link WebGLRenderer} / {@link WebGPURenderer}, nothing is baked:
 * every frame evaluates each branch's closed-form distance only inside
 * that branch's own bounding box, so geometry can change every frame
 * (growth, wind, parameter interpolation) at no extra cost, and edges
 * stay exact at any zoom instead of being limited by a 1024² bake.
 *
 * Call {@link setBranches} whenever the geometry changes (as often as
 * every frame), then {@link render}. WebGL 2 only. Uses an R16F distance
 * target when `EXT_color_buffer_float` is available, RGBA16F with
 * `EXT_color_buffer_half_float`, and otherwise (or if a float target
 * turns out not to be renderable) an RGBA8 target that stores distance
 * within ±8 px of each edge (enough for anti-aliasing, not for wide
 * distance-based effects). Survives WebGL context loss: rendering pauses
 * while the context is lost and resumes with the last branch set once it
 * is restored.
 */
export class BranchRenderer {
  readonly kind = 'webgl2' as const;

  private gl: WebGL2RenderingContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private distProgram: WebGLProgram | null = null;
  private compProgram: WebGLProgram | null = null;
  private distU: Record<string, WebGLUniformLocation | null> = {};
  private compU: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject | null = null;
  private emptyVao: WebGLVertexArrayObject | null = null;
  private cornerBuf: WebGLBuffer | null = null;
  private instanceBuf: WebGLBuffer | null = null;
  private boxBuf: WebGLBuffer | null = null;
  private capacity = 256;
  private instanceCapacity = 0;
  private packed: Float32Array = new Float32Array(0);
  private boxes: Float32Array = new Float32Array(0);
  /** Last instance data passed to setBranches, re-uploaded on restore. */
  private data: Float32Array | null = null;
  private _branchCount = 0;
  private distTex: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private targetW = 0;
  private targetH = 0;
  /** Target formats still worth trying, best first; never empty. */
  private formats: TargetFormat[] = ['rgba8'];
  private disposed = false;
  private readonly onLost = (e: Event): void => {
    // Opt in to restoration, and drop handles that died with the context.
    e.preventDefault();
    this.dropResources();
  };
  private readonly onRestored = (): void => {
    if (this.disposed || !this.gl) return;
    try {
      this.createResources(this.gl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[bezier-sdf] branch renderer restore failed:', err);
      this.dropResources();
    }
  };

  get branchCount(): number { return this._branchCount; }
  /** `'float'` when the full distance field is available to the
   *  composite pass, `'band'` on the RGBA8 fallback. */
  get distanceTarget(): 'float' | 'band' { return this.encoded ? 'band' : 'float'; }

  /** True when using the RGBA8 band-encoded distance target. */
  private get encoded(): boolean { return this.formats[0] === 'rgba8'; }

  async init({ canvas, capacity = 256 }: BranchRendererInitOptions): Promise<void> {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: false,
      alpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL 2 not supported');
    this.gl = gl;
    this.canvas = canvas;
    this.capacity = capacity;
    this.createResources(gl);
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  /**
   * Replace the branch set. Accepts branch objects or an already-packed
   * buffer in the {@link packBranches} layout (fastest for per-frame
   * animation: write straight into one reused Float32Array).
   */
  setBranches(branches: readonly TaperedBranch[] | Float32Array): void {
    if (!this.gl || this.disposed) return;
    if (branches instanceof Float32Array) {
      this.data = branches;
      this._branchCount = Math.floor(branches.length / BRANCH_STRIDE);
    } else {
      this.packed = packBranches(branches, this.packed);
      this.data = this.packed;
      this._branchCount = branches.length;
    }
    this.boxes = branchBoxes(this.data, this._branchCount, this.boxes);
    this.upload();
  }

  render(u: BranchUniforms): void {
    const gl = this.gl;
    if (!gl || this.disposed || !this.distProgram || gl.isContextLost()) return;
    const w = u.width, h = u.height;
    if (!this.ensureTarget(w, h)) return;
    const encoded = this.encoded;
    const px = 2 / (u.zoom * Math.min(w, h));
    const band = ENCODE_BAND_PX * px;

    // Pass 1: min-blend every branch's signed distance into the target.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(encoded ? 1 : FAR, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this._branchCount > 0) {
      gl.useProgram(this.distProgram);
      gl.uniform2f(this.distU.u_res!, w, h);
      gl.uniform1f(this.distU.u_zoom!, u.zoom);
      gl.uniform2f(this.distU.u_offset!, u.offsetX, u.offsetY);
      gl.uniform1f(this.distU.u_pad!, PAD_PX * px);
      gl.uniform1i(this.distU.u_encode!, encoded ? 1 : 0);
      gl.uniform1f(this.distU.u_band!, band);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MIN);
      gl.bindVertexArray(this.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this._branchCount);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
    }

    // Pass 2: distance → anti-aliased coverage on the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.compProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.distTex);
    gl.uniform1i(this.compU.u_dist!, 0);
    gl.uniform1i(this.compU.u_encode!, encoded ? 1 : 0);
    gl.uniform1f(this.compU.u_band!, band);
    gl.uniform1f(this.compU.u_px!, px);
    gl.uniform3f(this.compU.u_color!, u.color[0], u.color[1], u.color[2]);
    gl.uniform1f(this.compU.u_opacity!, u.opacity);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    this.disposed = true;
    this.canvas?.removeEventListener('webglcontextlost', this.onLost);
    this.canvas?.removeEventListener('webglcontextrestored', this.onRestored);
    this.canvas = null;
    if (!gl) return;
    gl.deleteProgram(this.distProgram);
    gl.deleteProgram(this.compProgram);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.emptyVao);
    gl.deleteBuffer(this.cornerBuf);
    gl.deleteBuffer(this.instanceBuf);
    gl.deleteBuffer(this.boxBuf);
    gl.deleteTexture(this.distTex);
    gl.deleteFramebuffer(this.fbo);
    this.dropResources();
    this.gl = null;
  }

  /** Build every GL object; used by init and after a context restore. */
  private createResources(gl: WebGL2RenderingContext): void {
    // Float formats need an extension to be renderable; RGBA8 always is.
    this.formats = [];
    if (gl.getExtension('EXT_color_buffer_float')) this.formats.push('r16f');
    if (gl.getExtension('EXT_color_buffer_half_float')) this.formats.push('rgba16f');
    this.formats.push('rgba8');

    this.distProgram = build(gl, BRANCH_DIST_VERT, BRANCH_DIST_FRAG);
    this.compProgram = build(gl, BRANCH_COMPOSITE_VERT, BRANCH_COMPOSITE_FRAG);
    this.distU = locations(gl, this.distProgram, ['u_res', 'u_zoom', 'u_offset', 'u_pad', 'u_encode', 'u_band']);
    this.compU = locations(gl, this.compProgram, ['u_dist', 'u_encode', 'u_band', 'u_px', 'u_color', 'u_opacity']);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuf = gl.createBuffer();
    this.boxBuf = gl.createBuffer();
    this.allocInstances(Math.max(this.capacity, this._branchCount));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    const stride = BRANCH_STRIDE * 4;
    instanceAttrib(gl, 1, 4, stride, 0);
    instanceAttrib(gl, 2, 4, stride, 16);
    instanceAttrib(gl, 3, 1, stride, 32);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuf);
    const boxStride = BRANCH_BOX_STRIDE * 4;
    instanceAttrib(gl, 4, 2, boxStride, 0);
    instanceAttrib(gl, 5, 4, boxStride, 8);
    gl.bindVertexArray(null);

    this.emptyVao = gl.createVertexArray();
    this.fbo = gl.createFramebuffer();
    this.upload();
  }

  /** Forget GL handles (lost with the context, or already deleted). */
  private dropResources(): void {
    this.distProgram = this.compProgram = null;
    this.distU = {};
    this.compU = {};
    this.vao = this.emptyVao = null;
    this.cornerBuf = this.instanceBuf = this.boxBuf = null;
    this.instanceCapacity = 0;
    this.distTex = null;
    this.fbo = null;
    this.targetW = this.targetH = 0;
  }

  /** Upload the current instance data and culling boxes, if possible. */
  private upload(): void {
    const gl = this.gl;
    const n = this._branchCount;
    if (!gl || !this.instanceBuf || !this.data || gl.isContextLost()) return;
    if (n > this.instanceCapacity) {
      this.allocInstances(Math.max(n, this.instanceCapacity * 2));
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, n * BRANCH_STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.boxes, 0, n * BRANCH_BOX_STRIDE);
  }

  private allocInstances(count: number): void {
    const gl = this.gl!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, count * BRANCH_STRIDE * 4, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuf);
    gl.bufferData(gl.ARRAY_BUFFER, count * BRANCH_BOX_STRIDE * 4, gl.DYNAMIC_DRAW);
    this.instanceCapacity = count;
  }

  /**
   * Make sure a complete distance target of the given size exists,
   * stepping down the format list when one is not renderable. Returns
   * false (skip the frame) only if even RGBA8 fails, e.g. mid context
   * loss; never throws, so a caller's animation loop keeps running.
   */
  private ensureTarget(w: number, h: number): boolean {
    const gl = this.gl!;
    if (this.distTex && w === this.targetW && h === this.targetH) return true;
    gl.deleteTexture(this.distTex);
    this.distTex = null;
    // An oversized target fails in every format; don't let it demote the
    // format list.
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (w < 1 || h < 1 || w > max || h > max) return false;
    for (;;) {
      const format = this.formats[0]!;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (format === 'r16f') {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.HALF_FLOAT, null);
      } else if (format === 'rgba16f') {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status === gl.FRAMEBUFFER_COMPLETE) {
        this.distTex = tex;
        this.targetW = w;
        this.targetH = h;
        return true;
      }
      gl.deleteTexture(tex);
      if (format === 'rgba8') return false;
      // eslint-disable-next-line no-console
      console.warn(`[bezier-sdf] ${format} branch distance target incomplete (0x${status.toString(16)}), falling back`);
      this.formats.shift();
    }
  }
}

function build(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const p = link(gl, vsSrc, fsSrc);
  if (!p) throw new Error('branch shader program failed to build (see console)');
  return p;
}

function instanceAttrib(
  gl: WebGL2RenderingContext,
  loc: number,
  size: number,
  stride: number,
  offset: number,
): void {
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
  gl.vertexAttribDivisor(loc, 1);
}

function locations(
  gl: WebGL2RenderingContext,
  p: WebGLProgram,
  names: string[],
): Record<string, WebGLUniformLocation | null> {
  const out: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) out[n] = gl.getUniformLocation(p, n);
  return out;
}
