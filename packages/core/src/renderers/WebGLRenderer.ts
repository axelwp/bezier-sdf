import type { Mark, Path, CubicSegment, RgbColor } from '../geometry/types';
import {
  MAX_LOOP_BOUND,
  MAX_PATHS,
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

/** Texture unit used to bind the segment-data texture during bake (and
 *  during the direct render). The bake program reads only this texture;
 *  the direct program reads only this texture. Picking unit 0 keeps it
 *  out of the way of the sample/glass programs' SDF bindings. */
const SEGMENT_TEXTURE_UNIT = 0;

interface SegmentTextureFormat {
  /** GL type passed to texImage2D. */
  type: number;
  /** Either 'float' (Float32Array data) or 'half' (Uint16Array data). */
  precision: 'float' | 'half';
}

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
  private bakeUniforms: Record<string, WebGLUniformLocation | null> = {};
  private sampleProgram: WebGLProgram | null = null;
  private directProgram: WebGLProgram | null = null;
  private glassProgram: WebGLProgram | null = null;
  private morphProgram: WebGLProgram | null = null;
  private morphTexA: WebGLTexture | null = null;
  private morphTexB: WebGLTexture | null = null;
  private morphSegTexA: WebGLTexture | null = null;
  private morphSegTexB: WebGLTexture | null = null;
  private morphUniforms: Record<string, WebGLUniformLocation | null> = {};
  private textures: WebGLTexture[] = [];
  /** Per-path segment-data textures, parallel to {@link textures}. Each
   *  packs the path's cubic control points into 2 RGBA texels per
   *  segment; sampled by the bake program at bake/rebake time. */
  private segmentTextures: WebGLTexture[] = [];
  /** Combined-segment texture for the direct render path. */
  private directSegmentTexture: WebGLTexture | null = null;
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
  /** Format used for the segment-data texture. RGBA32F if
   *  OES_texture_float is supported, else RGBA16F (which is also what
   *  the SDF render targets use). Null until init picks one. */
  private segmentFormat: SegmentTextureFormat | null = null;

  get mode(): 'baked' | 'direct' { return this._mode; }
  get pathCount(): number { return this._pathCount; }

  async init({ canvas, mark, backdrop, morphTo }: RendererInitOptions): Promise<void> {
    validateMark(mark, MAX_PATHS, MAX_LOOP_BOUND);
    if (morphTo) validateMark(morphTo, MAX_PATHS, MAX_LOOP_BOUND);
    // Combined-segment bound applies to both shapes in morph mode. Check
    // it BEFORE getContext binds the canvas — see WebGPURenderer for the
    // rationale (the symmetric concern there is poisoning the canvas for
    // the cross-backend fallback; here it preserves a clean throw path).
    if (morphTo) {
      validateMorphSegments(mark, 'morph: shape A');
      validateMorphSegments(morphTo, 'morph: shape B');
    }

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

    // Segment-data texture format. Either OES_texture_float (RGBA32F) or
    // OES_texture_half_float (RGBA16F) must be present — we sample with
    // NEAREST so no *_linear extension is needed. With neither available
    // there's no way to upload segment data and we have to throw; the
    // React static fallback already handles that case.
    const segFormat = pickSegmentFormat(gl);
    if (!segFormat) {
      throw new Error(
        'OES_texture_float or OES_texture_half_float required (neither available)',
      );
    }
    this.segmentFormat = segFormat;

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

    if (!this.initBakeProgram(gl)) return false;
    const bakeProgram = this.bakeProgram!;

    this.morphSegTexA = this.uploadSegmentTexture(gl, segsA);
    this.morphSegTexB = this.uploadSegmentTexture(gl, segsB);

    const texA = this.bakeOne(gl, bakeProgram, this.morphSegTexA, segsA.length, HALF_FLOAT_OES);
    const texB = this.bakeOne(gl, bakeProgram, this.morphSegTexB, segsB.length, HALF_FLOAT_OES);
    if (!texA || !texB) {
      if (texA) gl.deleteTexture(texA);
      if (texB) gl.deleteTexture(texB);
      gl.deleteTexture(this.morphSegTexA);
      gl.deleteTexture(this.morphSegTexB);
      this.morphSegTexA = null;
      this.morphSegTexB = null;
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

    if (!this.initBakeProgram(gl)) return false;
    const bakeProgram = this.bakeProgram!;

    const textures: WebGLTexture[] = [];
    const segmentTextures: WebGLTexture[] = [];
    for (const path of paths) {
      const segTex = this.uploadSegmentTexture(gl, path.segments);
      segmentTextures.push(segTex);
      const tex = this.bakeOne(gl, bakeProgram, segTex, path.segments.length, HALF_FLOAT_OES);
      if (!tex) {
        textures.forEach((t) => gl.deleteTexture(t));
        segmentTextures.forEach((t) => gl.deleteTexture(t));
        gl.deleteProgram(bakeProgram);
        this.bakeProgram = null;
        return false;
      }
      textures.push(tex);
    }
    this.textures = textures;
    this.segmentTextures = segmentTextures;
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
    segmentTex: WebGLTexture,
    segCount: number,
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

    if (!this.runBakeIntoTexture(gl, bakeProgram, tex, segmentTex, segCount)) {
      gl.deleteTexture(tex);
      return null;
    }
    return tex;
  }

  /**
   * Run the bake fragment program into `tex` from segments stored in
   * `segmentTex`. Allocates and disposes one FBO; both target and
   * segment textures are reused across rebakes. Returns false only if
   * framebuffer completeness check fails, which only happens at first-
   * bake time (extension support); once a texture has succeeded once
   * it'll succeed again.
   */
  private runBakeIntoTexture(
    gl: WebGLRenderingContext,
    bakeProgram: WebGLProgram,
    tex: WebGLTexture,
    segmentTex: WebGLTexture,
    segCount: number,
  ): boolean {
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
    gl.activeTexture(gl.TEXTURE0 + SEGMENT_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, segmentTex);
    const bU = this.bakeUniforms;
    gl.uniform1f(bU.bound!, WEBGL_BAKE_BOUND);
    gl.uniform1i(bU.segCount!, segCount);
    gl.uniform1f(bU.segmentTexWidth!, segCount * 2);
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

  /** Compile + cache the bake program and uniform locations. Idempotent. */
  private initBakeProgram(gl: WebGLRenderingContext): boolean {
    if (this.bakeProgram) return true;
    const program = link(gl, WEBGL_BAKE_VERT, WEBGL_BAKE_FRAG);
    if (!program) return false;
    this.bakeProgram = program;
    gl.useProgram(program);
    this.bakeUniforms = {
      bound:           gl.getUniformLocation(program, 'u_bound'),
      segCount:        gl.getUniformLocation(program, 'u_segCount'),
      segmentTexWidth: gl.getUniformLocation(program, 'u_segmentTexWidth'),
    };
    // u_segments lives on a fixed unit; set it once so render-time only
    // has to bind the texture itself.
    gl.uniform1i(gl.getUniformLocation(program, 'u_segments'), SEGMENT_TEXTURE_UNIT);
    return true;
  }

  /**
   * Allocate a new RGBA float (or half-float) texture sized to fit the
   * given segments and upload them. Each cubic occupies two consecutive
   * RGBA texels: texel 2i = (P0, P1), texel 2i+1 = (P2, P3). Sampled
   * with NEAREST so each fetch returns the exact stored values.
   */
  private uploadSegmentTexture(
    gl: WebGLRenderingContext,
    segments: readonly CubicSegment[],
  ): WebGLTexture {
    const fmt = this.segmentFormat;
    if (!fmt) throw new Error('segmentFormat not initialized');
    const segCount = segments.length;
    const texWidth = Math.max(segCount * 2, 1);
    const floats = new Float32Array(texWidth * 4);
    for (let i = 0; i < segCount; i++) {
      const c = segments[i]!;
      floats[i * 8 + 0] = c[0]!; floats[i * 8 + 1] = c[1]!;
      floats[i * 8 + 2] = c[2]!; floats[i * 8 + 3] = c[3]!;
      floats[i * 8 + 4] = c[4]!; floats[i * 8 + 5] = c[5]!;
      floats[i * 8 + 6] = c[6]!; floats[i * 8 + 7] = c[7]!;
    }
    const data = fmt.precision === 'float' ? floats : floatArrayToHalfFloat(floats);
    const tex = gl.createTexture();
    if (!tex) throw new Error('createTexture returned null');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, texWidth, 1, 0,
      gl.RGBA, fmt.type, data,
    );
    return tex;
  }

  /** In-place reupload of segment data into an existing texture. */
  private reuploadSegmentTexture(
    gl: WebGLRenderingContext,
    tex: WebGLTexture,
    segments: readonly CubicSegment[],
  ): void {
    const fmt = this.segmentFormat;
    if (!fmt) throw new Error('segmentFormat not initialized');
    const segCount = segments.length;
    const texWidth = Math.max(segCount * 2, 1);
    const floats = new Float32Array(texWidth * 4);
    for (let i = 0; i < segCount; i++) {
      const c = segments[i]!;
      floats[i * 8 + 0] = c[0]!; floats[i * 8 + 1] = c[1]!;
      floats[i * 8 + 2] = c[2]!; floats[i * 8 + 3] = c[3]!;
      floats[i * 8 + 4] = c[4]!; floats[i * 8 + 5] = c[5]!;
      floats[i * 8 + 6] = c[6]!; floats[i * 8 + 7] = c[7]!;
    }
    const data = fmt.precision === 'float' ? floats : floatArrayToHalfFloat(floats);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, texWidth, 1, 0,
      gl.RGBA, fmt.type, data,
    );
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
    validateMark(mark, MAX_PATHS, MAX_LOOP_BOUND);
    for (let i = 0; i < mark.paths.length; i++) {
      const segs = mark.paths[i]!.segments;
      const segTex = this.segmentTextures[i]!;
      this.reuploadSegmentTexture(gl, segTex, segs);
      this.runBakeIntoTexture(gl, this.bakeProgram, this.textures[i]!, segTex, segs.length);
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
    if (combined.length > MAX_LOOP_BOUND) {
      throw new Error(
        `direct mode has ${combined.length} combined segments but the bake shader's loop bound is ${MAX_LOOP_BOUND}. ` +
          'Simplify the source SVG (Inkscape → Path → Simplify) or merge duplicate paths.',
      );
    }
    const program = link(gl, WEBGL_VERT, WEBGL_DIRECT_FRAG);
    if (!program) throw new Error('direct shader failed to link');
    this.directProgram = program;
    gl.useProgram(program);
    const posLoc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    this.directUniforms = {
      res:             gl.getUniformLocation(program, 'u_res'),
      zoom:            gl.getUniformLocation(program, 'u_zoom'),
      offset:          gl.getUniformLocation(program, 'u_offset'),
      color:           gl.getUniformLocation(program, 'u_color'),
      opacity:         gl.getUniformLocation(program, 'u_opacity'),
      segCount:        gl.getUniformLocation(program, 'u_segCount'),
      segmentTexWidth: gl.getUniformLocation(program, 'u_segmentTexWidth'),
    };
    // u_segments lives on a fixed unit; bind once and rebind the texture
    // itself per-frame in render().
    gl.uniform1i(gl.getUniformLocation(program, 'u_segments'), SEGMENT_TEXTURE_UNIT);
    this.directSegmentTexture = this.uploadSegmentTexture(gl, combined);
    gl.uniform1i(this.directUniforms.segCount!, combined.length);
    gl.uniform1f(this.directUniforms.segmentTexWidth!, combined.length * 2);
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
      if (this.directSegmentTexture) {
        gl.activeTexture(gl.TEXTURE0 + SEGMENT_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, this.directSegmentTexture);
      }
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
      this.segmentTextures.forEach((t) => gl.deleteTexture(t));
      if (this.directSegmentTexture) gl.deleteTexture(this.directSegmentTexture);
      if (this.backdropTexture) gl.deleteTexture(this.backdropTexture);
      if (this.morphTexA) gl.deleteTexture(this.morphTexA);
      if (this.morphTexB) gl.deleteTexture(this.morphTexB);
      if (this.morphSegTexA) gl.deleteTexture(this.morphSegTexA);
      if (this.morphSegTexB) gl.deleteTexture(this.morphSegTexB);
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
    this.segmentTextures = [];
    this.directSegmentTexture = null;
    this.backdropTexture = null;
    this.morphTexA = null;
    this.morphTexB = null;
    this.morphSegTexA = null;
    this.morphSegTexB = null;
    this.buffer = null;
  }
}

/**
 * Pre-flight check used by `init()` before `getContext('webgl')` runs —
 * see the symmetric helper in {@link WebGPURenderer} for the rationale
 * (avoid binding the canvas only to throw mid-init, which would mask
 * the real cause behind a fallback's "WebGL not supported").
 */
function validateMorphSegments(mark: Mark, label: string): void {
  let total = 0;
  for (const p of mark.paths) total += p.segments.length;
  if (total > MAX_LOOP_BOUND) {
    throw new Error(
      `${label} has ${total} combined segments but the bake shader's loop bound is ${MAX_LOOP_BOUND}. ` +
        'Simplify the source SVG (Inkscape → Path → Simplify) or merge duplicate paths.',
    );
  }
}

function flattenSegments(mark: Mark, label: string): readonly CubicSegment[] {
  const segs: CubicSegment[] = [];
  for (const p of mark.paths) {
    for (const s of p.segments) segs.push(s);
  }
  if (segs.length > MAX_LOOP_BOUND) {
    throw new Error(
      `${label} has ${segs.length} combined segments but the bake shader's loop bound is ${MAX_LOOP_BOUND}. ` +
        'Simplify the source SVG (Inkscape → Path → Simplify) or merge duplicate paths.',
    );
  }
  return segs;
}

/**
 * Pick the highest-precision segment-data texture format the GL context
 * can support. RGBA32F is preferred (exact storage of cubic control
 * points); RGBA16F is the fallback. Both formats sample with NEAREST
 * filtering, so neither *_linear extension is required. The returned
 * `type` is the GLenum for `texImage2D`'s `type` argument; `precision`
 * tells callers whether to upload a Float32Array directly or convert to
 * Uint16 half-float bits first.
 */
function pickSegmentFormat(gl: WebGLRenderingContext): SegmentTextureFormat | null {
  // Probe by attempting to allocate a 1x1 texture in each format. Just
  // having the extension is necessary but not always sufficient — older
  // mobile drivers advertise OES_texture_float yet error on actual
  // upload. The probe is cheap and weeds those out at init.
  if (gl.getExtension('OES_texture_float')) {
    if (probeFormat(gl, gl.FLOAT, new Float32Array(4))) {
      return { type: gl.FLOAT, precision: 'float' };
    }
  }
  const halfFloat = gl.getExtension('OES_texture_half_float');
  if (halfFloat) {
    const HALF_FLOAT_OES = halfFloat.HALF_FLOAT_OES;
    if (probeFormat(gl, HALF_FLOAT_OES, new Uint16Array(4))) {
      return { type: HALF_FLOAT_OES, precision: 'half' };
    }
  }
  return null;
}

function probeFormat(
  gl: WebGLRenderingContext,
  type: number,
  data: ArrayBufferView,
): boolean {
  const tex = gl.createTexture();
  if (!tex) return false;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, type, data);
  const ok = gl.getError() === gl.NO_ERROR;
  gl.deleteTexture(tex);
  return ok;
}

/**
 * IEEE-754 binary16 conversion — converts a Float32Array of arbitrary
 * length to the matching Uint16Array of half-float bits, suitable for
 * upload via `texImage2D` with `HALF_FLOAT_OES`.
 *
 * Cubic control points in this library are normalized to roughly
 * [-1.2, 1.2], well inside half-float's representable range
 * (~6.1e-5..65504) and far above its precision floor (~1e-3 in our
 * range), so no fidelity is lost in practice.
 */
const f32Buf = new Float32Array(1);
const i32Buf = new Uint32Array(f32Buf.buffer);
function floatArrayToHalfFloat(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    f32Buf[0] = src[i]!;
    const x = i32Buf[0]!;
    const sign = (x >>> 16) & 0x8000;
    let exp = (x >>> 23) & 0xff;
    let frac = x & 0x7fffff;
    if (exp === 0xff) {
      // NaN or Infinity.
      out[i] = sign | 0x7c00 | (frac ? 0x200 : 0);
      continue;
    }
    let e = exp - 127 + 15;
    if (e >= 31) {
      // Overflow → ±Inf.
      out[i] = sign | 0x7c00;
      continue;
    }
    if (e <= 0) {
      if (e < -10) {
        // Below subnormal range → ±0.
        out[i] = sign;
        continue;
      }
      // Subnormal — shift in implicit leading 1, round to nearest.
      frac |= 0x800000;
      const shift = 1 - e;
      let halfFrac = frac >>> (shift + 13);
      if ((frac >>> (shift + 12)) & 1) halfFrac += 1;
      out[i] = sign | halfFrac;
      continue;
    }
    // Normal — round-to-nearest on the truncated mantissa.
    let halfFrac = frac >>> 13;
    if (frac & 0x1000) {
      halfFrac += 1;
      if (halfFrac & 0x400) {
        halfFrac = 0;
        e += 1;
        if (e >= 31) {
          out[i] = sign | 0x7c00;
          continue;
        }
      }
    }
    out[i] = sign | (e << 10) | halfFrac;
  }
  return out;
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
