import { BRANCH_STRIDE, packBranches, type TaperedBranch } from '../geometry/branch';
import {
  BRANCH_COMPOSITE_FRAG,
  BRANCH_COMPOSITE_VERT,
  BRANCH_DIST_FRAG,
  BRANCH_DIST_VERT,
} from '../shaders/branch';

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
 * target when `EXT_color_buffer_float` is available, otherwise an RGBA8
 * target that stores distance within ±8 px of each edge (enough for
 * anti-aliasing, not for wide distance-based effects).
 */
export class BranchRenderer {
  readonly kind = 'webgl2' as const;

  private gl: WebGL2RenderingContext | null = null;
  private distProgram: WebGLProgram | null = null;
  private compProgram: WebGLProgram | null = null;
  private distU: Record<string, WebGLUniformLocation | null> = {};
  private compU: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject | null = null;
  private emptyVao: WebGLVertexArrayObject | null = null;
  private cornerBuf: WebGLBuffer | null = null;
  private instanceBuf: WebGLBuffer | null = null;
  private instanceCapacity = 0;
  private packed: Float32Array = new Float32Array(0);
  private _branchCount = 0;
  private distTex: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private targetW = 0;
  private targetH = 0;
  /** True when falling back to the RGBA8 band-encoded distance target. */
  private encoded = false;
  private disposed = false;

  get branchCount(): number { return this._branchCount; }
  /** `'float'` when the full distance field is available to the
   *  composite pass, `'band'` on the RGBA8 fallback. */
  get distanceTarget(): 'float' | 'band' { return this.encoded ? 'band' : 'float'; }

  async init({ canvas, capacity = 256 }: BranchRendererInitOptions): Promise<void> {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: false,
      alpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL 2 not supported');
    this.gl = gl;
    this.encoded = !gl.getExtension('EXT_color_buffer_float');

    this.distProgram = link(gl, BRANCH_DIST_VERT, BRANCH_DIST_FRAG);
    this.compProgram = link(gl, BRANCH_COMPOSITE_VERT, BRANCH_COMPOSITE_FRAG);
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
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    this.allocInstances(capacity);
    const stride = BRANCH_STRIDE * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);

    this.emptyVao = gl.createVertexArray();
    this.fbo = gl.createFramebuffer();
  }

  /**
   * Replace the branch set. Accepts branch objects or an already-packed
   * buffer in the {@link packBranches} layout (fastest for per-frame
   * animation: write straight into one reused Float32Array).
   */
  setBranches(branches: readonly TaperedBranch[] | Float32Array): void {
    const gl = this.gl;
    if (!gl || this.disposed) return;
    let data: Float32Array;
    if (branches instanceof Float32Array) {
      data = branches;
      this._branchCount = Math.floor(branches.length / BRANCH_STRIDE);
    } else {
      this.packed = packBranches(branches, this.packed);
      data = this.packed;
      this._branchCount = branches.length;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    if (this._branchCount > this.instanceCapacity) {
      this.allocInstances(Math.max(this._branchCount, this.instanceCapacity * 2));
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, this._branchCount * BRANCH_STRIDE);
  }

  render(u: BranchUniforms): void {
    const gl = this.gl;
    if (!gl || this.disposed) return;
    const w = u.width, h = u.height;
    this.ensureTarget(w, h);
    const px = 2 / (u.zoom * Math.min(w, h));
    const band = ENCODE_BAND_PX * px;

    // Pass 1: min-blend every branch's signed distance into the target.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(this.encoded ? 1 : FAR, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this._branchCount > 0) {
      gl.useProgram(this.distProgram);
      gl.uniform2f(this.distU.u_res!, w, h);
      gl.uniform1f(this.distU.u_zoom!, u.zoom);
      gl.uniform2f(this.distU.u_offset!, u.offsetX, u.offsetY);
      gl.uniform1f(this.distU.u_pad!, PAD_PX * px);
      gl.uniform1i(this.distU.u_encode!, this.encoded ? 1 : 0);
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
    gl.uniform1i(this.compU.u_encode!, this.encoded ? 1 : 0);
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
    if (!gl) return;
    gl.deleteProgram(this.distProgram);
    gl.deleteProgram(this.compProgram);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.emptyVao);
    gl.deleteBuffer(this.cornerBuf);
    gl.deleteBuffer(this.instanceBuf);
    gl.deleteTexture(this.distTex);
    gl.deleteFramebuffer(this.fbo);
    this.gl = null;
  }

  /** Assumes the instance buffer is bound to ARRAY_BUFFER. */
  private allocInstances(count: number): void {
    const gl = this.gl!;
    gl.bufferData(gl.ARRAY_BUFFER, count * BRANCH_STRIDE * 4, gl.DYNAMIC_DRAW);
    this.instanceCapacity = count;
  }

  private ensureTarget(w: number, h: number): void {
    const gl = this.gl!;
    if (this.distTex && w === this.targetW && h === this.targetH) return;
    gl.deleteTexture(this.distTex);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.encoded) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.HALF_FLOAT, null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`branch distance target incomplete (0x${status.toString(16)})`);
    }
    this.distTex = tex;
    this.targetW = w;
    this.targetH = h;
  }
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`branch shader compile failed: ${log}`);
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`branch program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
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
