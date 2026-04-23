import type { Path, CubicSegment } from '../geometry/types';
import {
  MAX_PATHS,
  MAX_SEGS,
  WEBGL_BAKE_BOUND,
  WEBGL_BAKE_FRAG,
  WEBGL_BAKE_SIZE,
  WEBGL_BAKE_VERT,
  WEBGL_DIRECT_FRAG,
  WEBGL_SAMPLE_FRAG,
  WEBGL_VERT,
} from '../shaders/webgl';
import { type Renderer, type RendererInitOptions, type Uniforms, validateMark } from './types';

/**
 * WebGL 1 renderer.
 *
 * Two-mode design:
 *   - `baked` (preferred): each path's SDF is rasterized once into its
 *     own half-float texture at init. Per frame, we sample those tex-
 *     tures at animation-translated UVs and composite.
 *   - `direct` (fallback): if half-float color attachments aren't
 *     available, we evaluate the combined SDF per pixel per frame. No
 *     per-path animation or per-path color/mode — just a static single-
 *     color silhouette. Still correct, just less fun.
 */
export class WebGLRenderer implements Renderer {
  readonly kind = 'webgl' as const;

  private gl: WebGLRenderingContext | null = null;
  private buffer: WebGLBuffer | null = null;
  private bakeProgram: WebGLProgram | null = null;
  private sampleProgram: WebGLProgram | null = null;
  private directProgram: WebGLProgram | null = null;
  private textures: WebGLTexture[] = [];
  private sampleUniforms: Record<string, WebGLUniformLocation | null> = {};
  private directUniforms: Record<string, WebGLUniformLocation | null> = {};
  private _mode: 'baked' | 'direct' = 'baked';
  private _pathCount = 0;
  private disposed = false;
  private ripplesBuf = new Float32Array(16);

  get mode(): 'baked' | 'direct' { return this._mode; }
  get pathCount(): number { return this._pathCount; }

  async init({ canvas, mark }: RendererInitOptions): Promise<void> {
    validateMark(mark, MAX_PATHS, MAX_SEGS);

    const gl = canvas.getContext('webgl', {
      antialias: true,
      premultipliedAlpha: false,
      alpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;
    if (!gl.getExtension('OES_standard_derivatives')) {
      throw new Error('OES_standard_derivatives not available');
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Shared fullscreen quad.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.buffer = buf;

    this._pathCount = mark.paths.length;
    const bakeOk = this.tryInitBaked(gl, mark.paths);
    if (!bakeOk) {
      this._mode = 'direct';
      const combined = mark.paths.flatMap((p) => p.segments as CubicSegment[]);
      this.initDirect(gl, combined);
      // eslint-disable-next-line no-console
      console.info('[bezier-sdf] half-float textures unavailable, using direct shader (no per-path animation)');
    }
  }

  private tryInitBaked(gl: WebGLRenderingContext, paths: readonly Path[]): boolean {
    const halfFloat = gl.getExtension('OES_texture_half_float');
    const colorBuf = gl.getExtension('EXT_color_buffer_half_float');
    const halfFloatLinear = gl.getExtension('OES_texture_half_float_linear');
    if (!halfFloat || !colorBuf || !halfFloatLinear) return false;
    const HALF_FLOAT_OES = halfFloat.HALF_FLOAT_OES;

    const bakeProgram = link(gl, WEBGL_BAKE_VERT, WEBGL_BAKE_FRAG);
    if (!bakeProgram) return false;
    this.bakeProgram = bakeProgram;

    const textures: WebGLTexture[] = [];
    for (const path of paths) {
      const tex = this.bakeOne(gl, bakeProgram, path.segments, HALF_FLOAT_OES);
      if (!tex) {
        textures.forEach((t) => gl.deleteTexture(t));
        gl.deleteProgram(bakeProgram);
        this.bakeProgram = null;
        return false;
      }
      textures.push(tex);
    }
    this.textures = textures;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const sampleProgram = link(gl, WEBGL_VERT, WEBGL_SAMPLE_FRAG);
    if (!sampleProgram) {
      textures.forEach((t) => gl.deleteTexture(t));
      this.textures = [];
      gl.deleteProgram(bakeProgram);
      this.bakeProgram = null;
      return false;
    }
    this.sampleProgram = sampleProgram;
    gl.useProgram(sampleProgram);
    const posLoc = gl.getAttribLocation(sampleProgram, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const loc = (n: string) => gl.getUniformLocation(sampleProgram, n);
    this.sampleUniforms = {
      res:        loc('u_res'),
      zoom:       loc('u_zoom'),
      offset:     loc('u_offset'),
      color:      loc('u_color'),
      opacity:    loc('u_opacity'),
      bound:      loc('u_bound'),
      sminK:      loc('u_sminK'),
      pathCount:  loc('u_pathCount'),
      sdf0:       loc('u_sdf0'),
      sdf1:       loc('u_sdf1'),
      sdf2:       loc('u_sdf2'),
      sdf3:       loc('u_sdf3'),
      pathOffset0: loc('u_pathOffset0'),
      pathOffset1: loc('u_pathOffset1'),
      pathOffset2: loc('u_pathOffset2'),
      pathOffset3: loc('u_pathOffset3'),
      cursor:       loc('u_cursor'),
      cursorPull:   loc('u_cursorPull'),
      cursorRadius: loc('u_cursorRadius'),
      ripples:      loc('u_ripples'),
      compositeMode:     loc('u_compositeMode'),
      pathMode:          loc('u_pathMode'),
      pathStrokeHalfW:   loc('u_pathStrokeHalfW'),
      pathFillOpacity:   loc('u_pathFillOpacity'),
      pathStrokeOpacity: loc('u_pathStrokeOpacity'),
      pathFillColor0:    loc('u_pathFillColor0'),
      pathFillColor1:    loc('u_pathFillColor1'),
      pathFillColor2:    loc('u_pathFillColor2'),
      pathFillColor3:    loc('u_pathFillColor3'),
      pathStrokeColor0:  loc('u_pathStrokeColor0'),
      pathStrokeColor1:  loc('u_pathStrokeColor1'),
      pathStrokeColor2:  loc('u_pathStrokeColor2'),
      pathStrokeColor3:  loc('u_pathStrokeColor3'),
    };
    // Bind sampler-to-texture-unit mapping once.
    gl.uniform1i(this.sampleUniforms.sdf0!, 0);
    gl.uniform1i(this.sampleUniforms.sdf1!, 1);
    gl.uniform1i(this.sampleUniforms.sdf2!, 2);
    gl.uniform1i(this.sampleUniforms.sdf3!, 3);
    gl.uniform1f(this.sampleUniforms.bound!, WEBGL_BAKE_BOUND);
    gl.uniform1i(this.sampleUniforms.pathCount!, paths.length);
    return true;
  }

  private bakeOne(
    gl: WebGLRenderingContext,
    bakeProgram: WebGLProgram,
    segments: readonly CubicSegment[],
    halfFloatType: number,
  ): WebGLTexture | null {
    const [segA, segB] = packSegments(segments);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, WEBGL_BAKE_SIZE, WEBGL_BAKE_SIZE, 0,
      gl.RGBA, halfFloatType, null,
    );

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      return null;
    }

    gl.useProgram(bakeProgram);
    const posLoc = gl.getAttribLocation(bakeProgram, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(gl.getUniformLocation(bakeProgram, 'u_bound'), WEBGL_BAKE_BOUND);
    gl.uniform1i(gl.getUniformLocation(bakeProgram, 'u_segCount'), segments.length);
    gl.uniform4fv(gl.getUniformLocation(bakeProgram, 'u_segA'), segA);
    gl.uniform4fv(gl.getUniformLocation(bakeProgram, 'u_segB'), segB);
    gl.viewport(0, 0, WEBGL_BAKE_SIZE, WEBGL_BAKE_SIZE);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.enable(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    return tex;
  }

  private initDirect(gl: WebGLRenderingContext, combined: readonly CubicSegment[]) {
    const program = link(gl, WEBGL_VERT, WEBGL_DIRECT_FRAG);
    if (!program) throw new Error('direct shader failed to link');
    this.directProgram = program;
    gl.useProgram(program);
    const posLoc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    this.directUniforms = {
      res:      gl.getUniformLocation(program, 'u_res'),
      zoom:     gl.getUniformLocation(program, 'u_zoom'),
      offset:   gl.getUniformLocation(program, 'u_offset'),
      color:    gl.getUniformLocation(program, 'u_color'),
      opacity:  gl.getUniformLocation(program, 'u_opacity'),
      segCount: gl.getUniformLocation(program, 'u_segCount'),
      segA:     gl.getUniformLocation(program, 'u_segA'),
      segB:     gl.getUniformLocation(program, 'u_segB'),
    };
    const [segA, segB] = packSegments(combined);
    gl.uniform4fv(this.directUniforms.segA!, segA);
    gl.uniform4fv(this.directUniforms.segB!, segB);
    gl.uniform1i(this.directUniforms.segCount!, combined.length);
  }

  render(u: Uniforms): void {
    const gl = this.gl;
    if (!gl || this.disposed) return;
    gl.viewport(0, 0, u.width, u.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this._mode === 'baked' && this.sampleProgram) {
      gl.useProgram(this.sampleProgram);
      for (let i = 0; i < this.textures.length; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, this.textures[i]!);
      }
      const sU = this.sampleUniforms;
      gl.uniform2f(sU.res!, u.width, u.height);
      gl.uniform1f(sU.zoom!, u.zoom);
      gl.uniform2f(sU.offset!, u.offsetX, u.offsetY);
      gl.uniform3f(sU.color!, u.color[0], u.color[1], u.color[2]);
      gl.uniform1f(sU.opacity!, u.opacity);
      gl.uniform1f(sU.sminK!, u.sminK);
      const offs = u.pathOffsets;
      const setOff = (key: string, i: number) => {
        const o = offs[i];
        gl.uniform2f(sU[key]!, o ? o[0] : 0, o ? o[1] : 0);
      };
      setOff('pathOffset0', 0);
      setOff('pathOffset1', 1);
      setOff('pathOffset2', 2);
      setOff('pathOffset3', 3);
      const cursor = u.cursor ?? [0, 0];
      gl.uniform2f(sU.cursor!, cursor[0], cursor[1]);
      gl.uniform1f(sU.cursorPull!, u.cursorPull ?? 0);
      gl.uniform1f(sU.cursorRadius!, u.cursorRadius ?? 1);
      const rb = this.ripplesBuf;
      rb.fill(0);
      const ripples = u.ripples;
      if (ripples) {
        for (let i = 0; i < 4 && i < ripples.length; i++) {
          const r = ripples[i]!;
          rb[i * 4]     = r[0];
          rb[i * 4 + 1] = r[1];
          rb[i * 4 + 2] = r[2];
          rb[i * 4 + 3] = r[3];
        }
      }
      gl.uniform4fv(sU.ripples!, rb);

      // Decide composition mode. Any per-path field triggers per-path
      // mode; otherwise we stay in legacy smin+u_color mode so the reveal
      // example renders identically to before.
      const perPath =
        u.pathModes !== undefined ||
        u.pathFillColors !== undefined ||
        u.pathStrokeColors !== undefined ||
        u.pathStrokeHalfW !== undefined;
      gl.uniform1i(sU.compositeMode!, perPath ? 1 : 0);

      if (perPath) {
        const modes = u.pathModes ?? [];
        const modeVec = [0, 0, 0, 0];
        for (let i = 0; i < 4; i++) {
          const m = modes[i];
          modeVec[i] = m === 'stroke' ? 1 : m === 'both' ? 2 : 0;
        }
        gl.uniform4i(sU.pathMode!, modeVec[0]!, modeVec[1]!, modeVec[2]!, modeVec[3]!);

        const halfW = u.pathStrokeHalfW ?? [];
        gl.uniform4f(
          sU.pathStrokeHalfW!,
          halfW[0] ?? 0, halfW[1] ?? 0, halfW[2] ?? 0, halfW[3] ?? 0,
        );
        const fo = u.pathFillOpacity ?? [];
        gl.uniform4f(
          sU.pathFillOpacity!,
          fo[0] ?? 1, fo[1] ?? 1, fo[2] ?? 1, fo[3] ?? 1,
        );
        const so = u.pathStrokeOpacity ?? [];
        gl.uniform4f(
          sU.pathStrokeOpacity!,
          so[0] ?? 1, so[1] ?? 1, so[2] ?? 1, so[3] ?? 1,
        );

        const setColor = (loc: WebGLUniformLocation | null, c?: readonly [number, number, number]) => {
          if (!loc) return;
          gl.uniform3f(loc, c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0);
        };
        const fc = u.pathFillColors;
        setColor(sU.pathFillColor0!, fc?.[0]);
        setColor(sU.pathFillColor1!, fc?.[1]);
        setColor(sU.pathFillColor2!, fc?.[2]);
        setColor(sU.pathFillColor3!, fc?.[3]);
        const sc = u.pathStrokeColors;
        setColor(sU.pathStrokeColor0!, sc?.[0]);
        setColor(sU.pathStrokeColor1!, sc?.[1]);
        setColor(sU.pathStrokeColor2!, sc?.[2]);
        setColor(sU.pathStrokeColor3!, sc?.[3]);
      }

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return;
    }

    if (this.directProgram) {
      gl.useProgram(this.directProgram);
      const dU = this.directUniforms;
      gl.uniform2f(dU.res!, u.width, u.height);
      gl.uniform1f(dU.zoom!, u.zoom);
      gl.uniform2f(dU.offset!, u.offsetX, u.offsetY);
      gl.uniform3f(dU.color!, u.color[0], u.color[1], u.color[2]);
      gl.uniform1f(dU.opacity!, u.opacity);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    if (gl) {
      if (this.bakeProgram) gl.deleteProgram(this.bakeProgram);
      if (this.sampleProgram) gl.deleteProgram(this.sampleProgram);
      if (this.directProgram) gl.deleteProgram(this.directProgram);
      this.textures.forEach((t) => gl.deleteTexture(t));
      if (this.buffer) gl.deleteBuffer(this.buffer);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null;
    this.bakeProgram = null;
    this.sampleProgram = null;
    this.directProgram = null;
    this.textures = [];
    this.buffer = null;
  }
}

function packSegments(segments: readonly CubicSegment[]): [Float32Array, Float32Array] {
  const segA = new Float32Array(MAX_SEGS * 4);
  const segB = new Float32Array(MAX_SEGS * 4);
  for (let i = 0; i < segments.length; i++) {
    const c = segments[i]!;
    segA[i * 4 + 0] = c[0]!; segA[i * 4 + 1] = c[1]!;
    segA[i * 4 + 2] = c[2]!; segA[i * 4 + 3] = c[3]!;
    segB[i * 4 + 0] = c[4]!; segB[i * 4 + 1] = c[5]!;
    segB[i * 4 + 2] = c[6]!; segB[i * 4 + 3] = c[7]!;
  }
  return [segA, segB];
}

function link(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram | null {
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    // eslint-disable-next-line no-console
    console.warn('[bezier-sdf] program link failed:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // eslint-disable-next-line no-console
    console.warn('[bezier-sdf] shader compile failed:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
