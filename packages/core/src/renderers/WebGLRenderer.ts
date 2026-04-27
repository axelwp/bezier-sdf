import type { Mark, Path, CubicSegment, RgbColor } from '../geometry/types';
import {
  MAX_PATHS,
  MAX_SEGS,
  WEBGL_BAKE_BOUND,
  WEBGL_BAKE_FRAG,
  WEBGL_BAKE_SIZE,
  WEBGL_BAKE_VERT,
  WEBGL_DIRECT_FRAG,
  WEBGL_GLASS_FRAG,
  WEBGL_MORPH_FRAG,
  WEBGL_SAMPLE_FRAG,
  WEBGL_VERT,
} from '../shaders/webgl';
import { type Renderer, type RendererInitOptions, type Uniforms, validateMark } from './types';

const GLASS_DEFAULTS = {
  refractionStrength: 0.05,
  chromaticStrength: 0.015,
  fresnelStrength: 0.3,
  tintStrength: 0.1,
  frostStrength: 2.5,
  rimColor: [1, 1, 1] as const,
  tintColor: [0.91, 0.94, 1.0] as const,
};

/** Texture unit reserved for the backdrop — sits immediately past the
 *  MAX_PATHS SDF bindings so raising MAX_PATHS only shifts it. */
const BACKDROP_UNIT = MAX_PATHS;

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
  private glassProgram: WebGLProgram | null = null;
  private morphProgram: WebGLProgram | null = null;
  private morphTexA: WebGLTexture | null = null;
  private morphTexB: WebGLTexture | null = null;
  private morphUniforms: Record<string, WebGLUniformLocation | null> = {};
  private textures: WebGLTexture[] = [];
  private backdropTexture: WebGLTexture | null = null;
  private sampleUniforms: Record<string, WebGLUniformLocation | null> = {};
  private directUniforms: Record<string, WebGLUniformLocation | null> = {};
  private glassUniforms: Record<string, WebGLUniformLocation | null> = {};
  private _mode: 'baked' | 'direct' = 'baked';
  private _pathCount = 0;
  private disposed = false;
  private ripplesBuf = new Float32Array(16);
  // Reusable scratch buffers for per-path uniform writes. Sized to
  // MAX_PATHS once so render() doesn't allocate per frame.
  private pathOffsetBuf = new Float32Array(MAX_PATHS * 2);
  private pathModeBuf = new Int32Array(MAX_PATHS);
  private pathScalarBuf = new Float32Array(MAX_PATHS);
  private pathVec3Buf = new Float32Array(MAX_PATHS * 3);
  private halfFloatType = 0;

  get mode(): 'baked' | 'direct' { return this._mode; }
  get pathCount(): number { return this._pathCount; }

  async init({ canvas, mark, backdrop, morphTo }: RendererInitOptions): Promise<void> {
    validateMark(mark, MAX_PATHS, MAX_SEGS);
    if (morphTo) validateMark(morphTo, MAX_PATHS, MAX_SEGS);

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
    // With MAX_PATHS=16 the sample shader binds 16 texture units; glass
    // adds the backdrop for 17. Every modern GPU exposes at least 16,
    // but the WebGL 1 spec floor is 8. Fail loudly if the driver can't
    // bind enough rather than letting the render silently sample dummy
    // textures.
    const maxUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number;
    const needed = backdrop ? MAX_PATHS + 1 : MAX_PATHS;
    if (maxUnits < needed) {
      throw new Error(
        `this GPU exposes ${maxUnits} fragment texture units; bezier-sdf needs ${needed} (MAX_PATHS=${MAX_PATHS}${backdrop ? ' + backdrop' : ''})`,
      );
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

    if (morphTo) {
      // Morph mode is exclusive: skip the per-path sample/direct pipelines
      // and only bake the two combined SDFs needed by the morph shader.
      this._pathCount = 1;
      if (!this.initMorph(gl, mark, morphTo)) {
        throw new Error(
          'morph effect requires half-float texture extensions (unavailable in this context)',
        );
      }
      return;
    }

    this._pathCount = mark.paths.length;
    const bakeOk = this.tryInitBaked(gl, mark.paths);
    if (!bakeOk) {
      if (backdrop) {
        // Glass needs the baked SDF textures as the lens; we can't refract
        // through the direct path. Surface this so the caller falls back
        // cleanly (React → StaticFallback).
        throw new Error(
          'liquid-glass requires half-float texture extensions (unavailable in this context)',
        );
      }
      this._mode = 'direct';
      const combined = mark.paths.flatMap((p) => p.segments as CubicSegment[]);
      this.initDirect(gl, combined);
      // eslint-disable-next-line no-console
      console.info('[bezier-sdf] half-float textures unavailable, using direct shader (no per-path animation)');
    }

    if (backdrop) {
      this.initGlass(gl, backdrop);
    }
  }

  private initMorph(gl: WebGLRenderingContext, markA: Mark, markB: Mark): boolean {
    const segsA = flattenSegments(markA, 'morph: shape A');
    const segsB = flattenSegments(markB, 'morph: shape B');

    const halfFloat = gl.getExtension('OES_texture_half_float');
    const colorBuf = gl.getExtension('EXT_color_buffer_half_float');
    const halfFloatLinear = gl.getExtension('OES_texture_half_float_linear');
    if (!halfFloat || !colorBuf || !halfFloatLinear) return false;
    const HALF_FLOAT_OES = halfFloat.HALF_FLOAT_OES;
    this.halfFloatType = HALF_FLOAT_OES;

    const bakeProgram = link(gl, WEBGL_BAKE_VERT, WEBGL_BAKE_FRAG);
    if (!bakeProgram) return false;
    this.bakeProgram = bakeProgram;

    const texA = this.bakeOne(gl, bakeProgram, segsA, HALF_FLOAT_OES);
    const texB = this.bakeOne(gl, bakeProgram, segsB, HALF_FLOAT_OES);
    if (!texA || !texB) {
      if (texA) gl.deleteTexture(texA);
      if (texB) gl.deleteTexture(texB);
      gl.deleteProgram(bakeProgram);
      this.bakeProgram = null;
      return false;
    }
    this.morphTexA = texA;
    this.morphTexB = texB;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const program = link(gl, WEBGL_VERT, WEBGL_MORPH_FRAG);
    if (!program) {
      gl.deleteTexture(texA);
      gl.deleteTexture(texB);
      this.morphTexA = null;
      this.morphTexB = null;
      gl.deleteProgram(bakeProgram);
      this.bakeProgram = null;
      return false;
    }
    this.morphProgram = program;
    gl.useProgram(program);
    const posLoc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const loc = (n: string) => gl.getUniformLocation(program, n);
    this.morphUniforms = {
      res:         loc('u_res'),
      zoom:        loc('u_zoom'),
      offset:      loc('u_offset'),
      opacity:     loc('u_opacity'),
      bound:       loc('u_bound'),
      morphT:      loc('u_morphT'),
      colorA:      loc('u_colorA'),
      colorB:      loc('u_colorB'),
      aIsStroked:  loc('u_aIsStroked'),
      bIsStroked:  loc('u_bIsStroked'),
      aHalfWidth:  loc('u_aHalfWidth'),
      bHalfWidth:  loc('u_bHalfWidth'),
    };
    // SDF textures live on units 0 and 1 — set once, render() only rebinds
    // the textures themselves.
    gl.uniform1i(loc('u_sdfA'), 0);
    gl.uniform1i(loc('u_sdfB'), 1);
    gl.uniform1f(this.morphUniforms.bound!, WEBGL_BAKE_BOUND);
    return true;
  }

  private initGlass(gl: WebGLRenderingContext, backdrop: TexImageSource): void {
    const program = link(gl, WEBGL_VERT, WEBGL_GLASS_FRAG);
    if (!program) throw new Error('liquid-glass shader failed to link');
    this.glassProgram = program;
    gl.useProgram(program);
    const posLoc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const loc = (n: string) => gl.getUniformLocation(program, n);
    this.glassUniforms = {
      res:       loc('u_res'),
      zoom:      loc('u_zoom'),
      offset:    loc('u_offset'),
      opacity:   loc('u_opacity'),
      sminK:     loc('u_sminK'),
      bound:     loc('u_bound'),
      pathCount: loc('u_pathCount'),
      backdrop:           loc('u_backdrop'),
      refractionStrength: loc('u_refractionStrength'),
      chromaticStrength:  loc('u_chromaticStrength'),
      fresnelStrength:    loc('u_fresnelStrength'),
      tintStrength:       loc('u_tintStrength'),
      frostStrength:      loc('u_frostStrength'),
      rimColor:           loc('u_rimColor'),
      tintColor:          loc('u_tintColor'),
      cursor:             loc('u_cursor'),
      cursorPull:         loc('u_cursorPull'),
      cursorRadius:       loc('u_cursorRadius'),
      ripples:            loc('u_ripples'),
      pathOffset:         loc('u_pathOffset[0]'),
      pathMode:           loc('u_pathMode[0]'),
      pathStrokeHalfW:    loc('u_pathStrokeHalfW[0]'),
    };
    // Texture-unit bindings: baked SDFs on 0..MAX_PATHS-1, backdrop just
    // past them. Same layout as the sample program so both can share the
    // bound textures without reshuffling between draws.
    for (let i = 0; i < MAX_PATHS; i++) {
      gl.uniform1i(loc(`u_sdf${i}`), i);
    }
    gl.uniform1i(this.glassUniforms.backdrop!, BACKDROP_UNIT);
    gl.uniform1f(this.glassUniforms.bound!, WEBGL_BAKE_BOUND);
    gl.uniform1i(this.glassUniforms.pathCount!, this._pathCount);

    // Backdrop texture. CORS-tainted sources throw here — caller should
    // catch and guide the user to same-origin or CORS-enabled hosting.
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + BACKDROP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE,
      backdrop as TexImageSource,
    );
    this.backdropTexture = tex;

    // Restore the sample program's a_pos binding (init'd last in baked
    // path), so the next render() call doesn't need to rebind.
    if (this.sampleProgram) {
      gl.useProgram(this.sampleProgram);
      const sp = gl.getAttribLocation(this.sampleProgram, 'a_pos');
      gl.enableVertexAttribArray(sp);
      gl.vertexAttribPointer(sp, 2, gl.FLOAT, false, 0, 0);
    }
  }

  private tryInitBaked(gl: WebGLRenderingContext, paths: readonly Path[]): boolean {
    const halfFloat = gl.getExtension('OES_texture_half_float');
    const colorBuf = gl.getExtension('EXT_color_buffer_half_float');
    const halfFloatLinear = gl.getExtension('OES_texture_half_float_linear');
    if (!halfFloat || !colorBuf || !halfFloatLinear) return false;
    const HALF_FLOAT_OES = halfFloat.HALF_FLOAT_OES;
    this.halfFloatType = HALF_FLOAT_OES;

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
      cursor:       loc('u_cursor'),
      cursorPull:   loc('u_cursorPull'),
      cursorRadius: loc('u_cursorRadius'),
      ripples:      loc('u_ripples'),
      compositeMode:     loc('u_compositeMode'),
      // GLSL uniform-array locations: query element [0] and pass the
      // whole flat buffer to uniform{1,2,3,4}{f,i}v — the driver infers
      // array length from the buffer size.
      pathOffset:        loc('u_pathOffset[0]'),
      pathMode:          loc('u_pathMode[0]'),
      pathStrokeHalfW:   loc('u_pathStrokeHalfW[0]'),
      pathFillOpacity:   loc('u_pathFillOpacity[0]'),
      pathStrokeOpacity: loc('u_pathStrokeOpacity[0]'),
      pathFillColor:     loc('u_pathFillColor[0]'),
      pathStrokeColor:   loc('u_pathStrokeColor[0]'),
    };
    // Bind sampler-to-texture-unit mapping once per program. Each u_sdfN
    // lives on texture unit N; setting it here means render() only has
    // to bind the actual textures, not rewire samplers.
    for (let i = 0; i < MAX_PATHS; i++) {
      gl.uniform1i(loc(`u_sdf${i}`), i);
    }
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

    if (!this.runBakeIntoTexture(gl, bakeProgram, tex, segments)) {
      gl.deleteTexture(tex);
      return null;
    }
    return tex;
  }

  /**
   * Run the bake fragment program into `tex` with the given segments.
   * Allocates and disposes one FBO; the texture is shared and reused
   * across rebakes. Returns false only if framebuffer completeness check
   * fails, which only happens at first-bake time (extension support);
   * once a texture has succeeded once it'll succeed again.
   */
  private runBakeIntoTexture(
    gl: WebGLRenderingContext,
    bakeProgram: WebGLProgram,
    tex: WebGLTexture,
    segments: readonly CubicSegment[],
  ): boolean {
    const [segA, segB] = packSegments(segments);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      return false;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
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
    return true;
  }

  rebake(mark: Mark): void {
    const gl = this.gl;
    if (!gl || this.disposed) return;
    if (this._mode !== 'baked' || !this.bakeProgram) return; // direct mode: nothing to bake
    if (mark.paths.length !== this.textures.length) {
      throw new Error(
        `rebake: mark has ${mark.paths.length} paths but renderer was init'd with ${this.textures.length}`,
      );
    }
    validateMark(mark, MAX_PATHS, MAX_SEGS);
    for (let i = 0; i < mark.paths.length; i++) {
      this.runBakeIntoTexture(gl, this.bakeProgram, this.textures[i]!, mark.paths[i]!.segments);
    }
    // Restore the sample program's vertex attrib state — runBakeIntoTexture
    // bound the bake program's a_pos. Calling render() next switches
    // programs and re-binds, so this isn't strictly required, but be tidy.
    if (this.sampleProgram) {
      gl.useProgram(this.sampleProgram);
      const posLoc = gl.getAttribLocation(this.sampleProgram, 'a_pos');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    }
  }

  setBackdrop(source: TexImageSource): void {
    const gl = this.gl;
    if (!gl || this.disposed) return;
    if (!this.backdropTexture) return; // no glass pipeline → nothing to update
    gl.activeTexture(gl.TEXTURE0 + BACKDROP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.backdropTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE,
      source,
    );
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

  /** Pack `MAX_PATHS` vec2 offsets into {@link pathOffsetBuf}. */
  private fillPathOffsets(u: Uniforms): Float32Array {
    const buf = this.pathOffsetBuf;
    for (let i = 0; i < MAX_PATHS; i++) {
      const o = u.pathOffsets[i];
      buf[i * 2]     = o ? o[0] : 0;
      buf[i * 2 + 1] = o ? o[1] : 0;
    }
    return buf;
  }

  /** Pack per-path mode values (fill=0 / stroke=1 / both=2). */
  private fillPathModes(u: Uniforms): Int32Array {
    const buf = this.pathModeBuf;
    const modes = u.pathModes;
    for (let i = 0; i < MAX_PATHS; i++) {
      const m = modes?.[i];
      buf[i] = m === 'stroke' ? 1 : m === 'both' ? 2 : 0;
    }
    return buf;
  }

  /** Pack an optional per-path scalar list into the shared scratch buffer. */
  private fillPathScalars(
    src: ReadonlyArray<number> | undefined,
    fallback: number,
  ): Float32Array {
    const buf = this.pathScalarBuf;
    for (let i = 0; i < MAX_PATHS; i++) buf[i] = src?.[i] ?? fallback;
    return buf;
  }

  /** Pack per-path RGB colors into a flat vec3 array. */
  private fillPathColors(src: ReadonlyArray<RgbColor> | undefined): Float32Array {
    const buf = this.pathVec3Buf;
    for (let i = 0; i < MAX_PATHS; i++) {
      const c = src?.[i];
      buf[i * 3]     = c?.[0] ?? 0;
      buf[i * 3 + 1] = c?.[1] ?? 0;
      buf[i * 3 + 2] = c?.[2] ?? 0;
    }
    return buf;
  }

  render(u: Uniforms): void {
    const gl = this.gl;
    if (!gl || this.disposed) return;
    gl.viewport(0, 0, u.width, u.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (u.morph && this.morphProgram && this.morphTexA && this.morphTexB) {
      gl.useProgram(this.morphProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.morphTexA);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.morphTexB);

      const mU = this.morphUniforms;
      gl.uniform2f(mU.res!, u.width, u.height);
      gl.uniform1f(mU.zoom!, u.zoom);
      gl.uniform2f(mU.offset!, u.offsetX, u.offsetY);
      gl.uniform1f(mU.opacity!, u.opacity);
      gl.uniform1f(mU.morphT!, u.morph.t);
      const ca = u.morph.colorA;
      const cb = u.morph.colorB;
      gl.uniform3f(mU.colorA!, ca[0], ca[1], ca[2]);
      gl.uniform3f(mU.colorB!, cb[0], cb[1], cb[2]);
      gl.uniform1f(mU.aIsStroked!, u.morph.aIsStroked ? 1 : 0);
      gl.uniform1f(mU.bIsStroked!, u.morph.bIsStroked ? 1 : 0);
      gl.uniform1f(mU.aHalfWidth!, u.morph.aHalfWidth ?? 0);
      gl.uniform1f(mU.bHalfWidth!, u.morph.bHalfWidth ?? 0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return;
    }

    if (u.glass && this.glassProgram && this.backdropTexture) {
      gl.useProgram(this.glassProgram);
      // Bind per-path SDFs on units 0..MAX_PATHS-1, backdrop on BACKDROP_UNIT.
      for (let i = 0; i < this.textures.length; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, this.textures[i]!);
      }
      gl.activeTexture(gl.TEXTURE0 + BACKDROP_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.backdropTexture);

      const gU = this.glassUniforms;
      gl.uniform2f(gU.res!, u.width, u.height);
      gl.uniform1f(gU.zoom!, u.zoom);
      gl.uniform2f(gU.offset!, u.offsetX, u.offsetY);
      gl.uniform1f(gU.opacity!, u.opacity);
      gl.uniform1f(gU.sminK!, u.sminK);
      gl.uniform1f(gU.refractionStrength!, u.refractionStrength ?? GLASS_DEFAULTS.refractionStrength);
      gl.uniform1f(gU.chromaticStrength!, u.chromaticStrength ?? GLASS_DEFAULTS.chromaticStrength);
      gl.uniform1f(gU.fresnelStrength!, u.fresnelStrength ?? GLASS_DEFAULTS.fresnelStrength);
      gl.uniform1f(gU.tintStrength!, u.tintStrength ?? GLASS_DEFAULTS.tintStrength);
      gl.uniform1f(gU.frostStrength!, u.frostStrength ?? GLASS_DEFAULTS.frostStrength);
      const rim = u.rimColor ?? GLASS_DEFAULTS.rimColor;
      gl.uniform3f(gU.rimColor!, rim[0], rim[1], rim[2]);
      const tint = u.tintColor ?? GLASS_DEFAULTS.tintColor;
      gl.uniform3f(gU.tintColor!, tint[0], tint[1], tint[2]);

      const gCursor = u.cursor ?? [0, 0];
      gl.uniform2f(gU.cursor!, gCursor[0], gCursor[1]);
      gl.uniform1f(gU.cursorPull!, u.cursorPull ?? 0);
      gl.uniform1f(gU.cursorRadius!, u.cursorRadius ?? 1);
      const grb = this.ripplesBuf;
      grb.fill(0);
      const gRipples = u.ripples;
      if (gRipples) {
        for (let i = 0; i < 4 && i < gRipples.length; i++) {
          const r = gRipples[i]!;
          grb[i * 4]     = r[0];
          grb[i * 4 + 1] = r[1];
          grb[i * 4 + 2] = r[2];
          grb[i * 4 + 3] = r[3];
        }
      }
      gl.uniform4fv(gU.ripples!, grb);

      gl.uniform2fv(gU.pathOffset!, this.fillPathOffsets(u));
      // Per-path render mode + stroke half-width, so stroked paths go
      // through the glass shader as their sausage SDF (abs(d) - halfW)
      // instead of as solid silhouettes. Unset → treated as fills, which
      // matches legacy single-color smin behavior.
      gl.uniform4iv(gU.pathMode!, this.fillPathModes(u));
      gl.uniform4fv(gU.pathStrokeHalfW!, this.fillPathScalars(u.pathStrokeHalfW, 0));

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return;
    }

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
      gl.uniform2fv(sU.pathOffset!, this.fillPathOffsets(u));
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
        gl.uniform4iv(sU.pathMode!, this.fillPathModes(u));
        gl.uniform4fv(sU.pathStrokeHalfW!, this.fillPathScalars(u.pathStrokeHalfW, 0));
        gl.uniform4fv(sU.pathFillOpacity!, this.fillPathScalars(u.pathFillOpacity, 1));
        gl.uniform4fv(sU.pathStrokeOpacity!, this.fillPathScalars(u.pathStrokeOpacity, 1));
        gl.uniform3fv(sU.pathFillColor!, this.fillPathColors(u.pathFillColors));
        gl.uniform3fv(sU.pathStrokeColor!, this.fillPathColors(u.pathStrokeColors));
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
      if (this.glassProgram) gl.deleteProgram(this.glassProgram);
      if (this.morphProgram) gl.deleteProgram(this.morphProgram);
      this.textures.forEach((t) => gl.deleteTexture(t));
      if (this.backdropTexture) gl.deleteTexture(this.backdropTexture);
      if (this.morphTexA) gl.deleteTexture(this.morphTexA);
      if (this.morphTexB) gl.deleteTexture(this.morphTexB);
      if (this.buffer) gl.deleteBuffer(this.buffer);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null;
    this.bakeProgram = null;
    this.sampleProgram = null;
    this.directProgram = null;
    this.glassProgram = null;
    this.morphProgram = null;
    this.textures = [];
    this.backdropTexture = null;
    this.morphTexA = null;
    this.morphTexB = null;
    this.buffer = null;
  }
}

function flattenSegments(mark: Mark, label: string): readonly CubicSegment[] {
  const segs: CubicSegment[] = [];
  for (const p of mark.paths) {
    for (const s of p.segments) segs.push(s);
  }
  if (segs.length > MAX_SEGS) {
    throw new Error(
      `${label} has ${segs.length} combined segments but the bake shader's MAX_SEGS is ${MAX_SEGS}. ` +
        'Simplify the source SVG (Inkscape → Path → Simplify) or merge duplicate paths.',
    );
  }
  return segs;
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
