import type { CubicSegment, Mark, Path, RgbColor } from '../geometry/types';
import { MORPH_MAX_PATHS, prepareMorphPair } from '../geometry/morphPair';
import {
  MAX_PATHS,
  WEBGPU_BACKDROP_BINDING,
  WEBGPU_BAKE_OFFSETS,
  WEBGPU_BAKE_SHADER,
  WEBGPU_BAKE_BOUND,
  WEBGPU_BAKE_SIZE,
  WEBGPU_BAKE_UNIFORM_SIZE,
  WEBGPU_DYNAMIC_SDF_B_BINDING,
  WEBGPU_GLASS_OFFSETS,
  WEBGPU_GLASS_SHADER,
  WEBGPU_GLASS_UNIFORM_SIZE,
  WEBGPU_MORPH_OFFSETS,
  WEBGPU_GLASS_NEAREST_SAMPLER_BINDING,
  WEBGPU_MORPH_NEAREST_SAMPLER_BINDING,
  WEBGPU_MORPH_PATH_IDX_A_BINDING,
  WEBGPU_MORPH_PATH_IDX_B_BINDING,
  WEBGPU_MORPH_SDF_A_BINDING,
  WEBGPU_MORPH_SDF_B_BINDING,
  WEBGPU_MORPH_SHADER,
  WEBGPU_MORPH_UNIFORM_SIZE,
  WEBGPU_PATH_IDX_A_BINDING,
  WEBGPU_PATH_IDX_B_BINDING,
  WEBGPU_SAMPLE_OFFSETS,
  WEBGPU_SAMPLE_SHADER,
  WEBGPU_SAMPLE_UNIFORM_SIZE,
} from '../shaders/webgpu';
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

function textureSourceSize(src: TexImageSource): [number, number] {
  // HTMLImageElement exposes naturalWidth/naturalHeight, which is the
  // actual decoded size; `.width`/`.height` can be CSS-sized. Other
  // accepted sources (HTMLCanvasElement, ImageBitmap) have width/height
  // in pixels.
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
    return [src.naturalWidth || src.width, src.naturalHeight || src.height];
  }
  const anySrc = src as { width: number; height: number };
  return [anySrc.width, anySrc.height];
}

/**
 * Per-shape segment-count cap, matched to the WebGL shader's compile-
 * time loop bound (see {@link MAX_LOOP_BOUND} in shaders/webgl.ts) so a
 * mark accepted by one renderer is accepted by the other. WebGPU's
 * storage buffer + WGSL `arrayLength` already supports any size; this
 * cap exists purely for cross-backend parity.
 */
const MAX_SEGMENTS_PER_SHAPE = 1024;

/** First texture binding index for SDFs in both sample and glass layouts.
 *  Binding 0 = uniform, 1 = sampler, then MAX_PATHS SDFs, then backdrop
 *  (glass only) at {@link WEBGPU_BACKDROP_BINDING}. */
const SDF_BINDING_START = 2;

export class WebGPURenderer implements Renderer {
  readonly kind = 'webgpu' as const;

  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = 'bgra8unorm';
  private samplePipeline: GPURenderPipeline | null = null;
  private bakePipeline: GPURenderPipeline | null = null;
  private bakeBindGroupLayout: GPUBindGroupLayout | null = null;
  /** Nearest-filter sampler used by the path-index lookups in the
   *  morph and glass+morph render shaders. The main `sampler` is
   *  linear (smooth SDF + backdrop sampling); we need exact-texel
   *  reads for the integer-encoded path-index map to avoid blending
   *  indices across region boundaries. */
  private nearestSampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private textures: GPUTexture[] = [];
  private dummyTexture: GPUTexture | null = null;
  private sampleBindGroup: GPUBindGroup | null = null;
  private uniformData = new ArrayBuffer(WEBGPU_SAMPLE_UNIFORM_SIZE);
  private glassPipeline: GPURenderPipeline | null = null;
  private glassUniformBuffer: GPUBuffer | null = null;
  private glassBindGroup: GPUBindGroup | null = null;
  private glassBindGroupLayout: GPUBindGroupLayout | null = null;
  private sampler: GPUSampler | null = null;
  private backdropTexture: GPUTexture | null = null;
  private glassUniformData = new ArrayBuffer(WEBGPU_GLASS_UNIFORM_SIZE);
  private morphPipeline: GPURenderPipeline | null = null;
  private morphUniformBuffer: GPUBuffer | null = null;
  private morphBindGroup: GPUBindGroup | null = null;
  /** Single combined SDF for morph shape A (flatten-then-bake). */
  private morphTexA: GPUTexture | null = null;
  private morphTexB: GPUTexture | null = null;
  /** Per-side path-index textures — each pixel stores which sub-path
   *  "won" the union at bake time, sampled by the morph render pipeline
   *  to look up per-path colors and preserve source SVG region colors
   *  through the morph. */
  private morphPathIdxTexA: GPUTexture | null = null;
  private morphPathIdxTexB: GPUTexture | null = null;
  private morphUniformData = new ArrayBuffer(WEBGPU_MORPH_UNIFORM_SIZE);
  private _pathCount = 0;
  private disposed = false;

  readonly mode = 'baked' as const;
  get pathCount(): number { return this._pathCount; }

  async init({ canvas, mark, backdrop, morphTo, morphFillRule }: RendererInitOptions): Promise<void> {
    validateMark(mark, MAX_PATHS, MAX_SEGMENTS_PER_SHAPE);
    if (morphTo) validateMark(morphTo, MAX_PATHS, MAX_SEGMENTS_PER_SHAPE);
    // Morph flattens each side into a single combined SDF, so the
    // *total* segment count per side must fit MAX_SEGMENTS_PER_SHAPE.
    // Run this check BEFORE acquiring the WebGPU context: getContext
    // ('webgpu') irreversibly binds the canvas to WebGPU, so any
    // subsequent throw poisons the WebGL fallback path. Validating up
    // front keeps fallback paths clean.
    if (morphTo) {
      const prep = prepareMorphPair(mark, morphTo);
      validateCombined(prep.markA, 'A');
      validateCombined(prep.markB, 'B');
    }
    this._pathCount = morphTo ? 1 : mark.paths.length;

    if (!('gpu' in navigator) || !navigator.gpu) {
      throw new Error('WebGPU not available');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
    if (!adapter) throw new Error('no WebGPU adapter');
    // Glass binds 16 SDF textures + backdrop + dynamic-SDF "shape B"
    // + 2 path-index maps = 20 sampled textures in one stage, four past
    // the WebGPU default minimum of 16. Request the extra up front so
    // requestDevice rejects on adapters that can't meet it — clearer
    // than a later pipeline-creation failure. Every desktop GPU driver
    // exposes thousands; the downgrade path only matters on very
    // constrained embedded targets. All four extra slots are reserved
    // when glass is active even in plain glass mode (they're bound to
    // a 1×1 dummy and unread — the shader gates samples on `dynamicSdf`).
    const sampledTextureLimit = backdrop ? MAX_PATHS + 4 : MAX_PATHS;
    const adapterMax = adapter.limits.maxSampledTexturesPerShaderStage;
    if (adapterMax < sampledTextureLimit) {
      throw new Error(
        `adapter exposes maxSampledTexturesPerShaderStage=${adapterMax}; bezier-sdf needs ${sampledTextureLimit} (MAX_PATHS=${MAX_PATHS}${backdrop ? ' + backdrop + sdfB + 2× pathIdx' : ''})`,
      );
    }
    const device = await adapter.requestDevice({
      requiredLimits: { maxSampledTexturesPerShaderStage: sampledTextureLimit },
    });
    this.device = device;
    device.lost.then((info) => {
      if (this.disposed) return;
      // eslint-disable-next-line no-console
      console.warn('[bezier-sdf] GPU device lost:', info.message);
    });

    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('could not acquire webgpu context');
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: 'premultiplied' });

    // --- Bake pipeline (shared across all paths) ---
    const bakeShader = device.createShaderModule({ code: WEBGPU_BAKE_SHADER });
    const bakeBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const bakePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bakeBindGroupLayout] }),
      vertex: { module: bakeShader, entryPoint: 'vs_main' },
      fragment: { module: bakeShader, entryPoint: 'fs_main', targets: [{ format: 'r16float' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.bakePipeline = bakePipeline;
    this.bakeBindGroupLayout = bakeBindGroupLayout;

    if (morphTo) {
      // Morph mode is exclusive against the per-path sample pipeline:
      // only the combined-per-side SDFs are baked. With a backdrop the
      // glass pipeline is compiled instead of the dedicated morph
      // render pipeline — the glass shader's dynamic-SDF mode samples
      // both morph SDFs and blends them per fragment, producing
      // refraction through a continuously-morphing silhouette.
      this.initMorph(device, mark, morphTo, morphFillRule ?? 'nonzero', backdrop);
      return;
    }

    this.textures = mark.paths.map((p) => this.allocBakeTexture(device));
    for (let i = 0; i < mark.paths.length; i++) {
      const segs = mark.paths[i]!.segments;
      // Per-path bake: pathEnds=[segCount], pathCount=1, so the inner
      // loop walks just this path's segments and even-odd parity is
      // computed within them. Visually identical to the prior
      // global-segments bake for a single-path input. We force fill
      // mode here regardless of `mark.paths[i].mode` — for non-morph,
      // strokes are realised at sample time via abs(d) - halfW, which
      // depends only on |d| and so is insensitive to the bake's parity
      // sign.
      this.runBakeSegments(device, this.textures[i]!, segs, [segs.length], 0, [0], [0]);
    }

    // Dummy 1x1 texture for unused path slots — WebGPU requires every
    // texture binding to be satisfied even when pathCount < MAX_PATHS.
    this.dummyTexture = device.createTexture({
      size: [1, 1],
      format: 'r16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    // Clear dummy (must issue at least one pass for the texture to be readable).
    {
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: this.dummyTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.end();
      device.queue.submit([enc.finish()]);
    }

    // --- Sample pipeline ---
    this.uniformBuffer = device.createBuffer({
      size: WEBGPU_SAMPLE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.sampler = sampler;
    // Nearest sampler used by glass-on-morph for path-index lookups.
    // Plain glass mode also gets the binding (the bind group always
    // includes it for layout stability), but never samples through it.
    this.nearestSampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const sampleShader = device.createShaderModule({ code: WEBGPU_SAMPLE_SHADER });
    const sampleBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ...Array.from({ length: MAX_PATHS }, (_, i) => ({
          binding: SDF_BINDING_START + i,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
        })),
      ],
    });
    this.samplePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [sampleBindGroupLayout] }),
      vertex: { module: sampleShader, entryPoint: 'vs_main' },
      fragment: {
        module: sampleShader,
        entryPoint: 'fs_main',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    const viewFor = (i: number) =>
      (i < this.textures.length ? this.textures[i]! : this.dummyTexture!).createView();
    this.sampleBindGroup = device.createBindGroup({
      layout: sampleBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: sampler },
        ...Array.from({ length: MAX_PATHS }, (_, i) => ({
          binding: SDF_BINDING_START + i,
          resource: viewFor(i),
        })),
      ],
    });

    // --- Glass pipeline (only when a backdrop is supplied) ---
    if (backdrop) {
      this.initGlass(device, sampler, backdrop, viewFor);
    }
  }

  private initMorph(
    device: GPUDevice,
    markA: Mark,
    markB: Mark,
    fillRule: 'nonzero' | 'evenodd',
    backdrop?: TexImageSource,
  ): void {
    const prep = prepareMorphPair(markA, markB);
    const fillRuleCode = fillRule === 'evenodd' ? 1 : 0;

    // Flatten each side into one combined segment list and bake into a
    // single SDF using the chosen fill rule. The bake's sceneSDF walks
    // pathEnds[] to compute per-path even-odd parity (nonzero) or one
    // global crossing count (evenodd). Two passes per side: distance
    // (outputMode=0) and path-index (outputMode=1). The path-index map
    // lets the morph render shader look up per-path colors at sample
    // time so source SVG region colors survive the unified bake.
    const flatA = flattenForBake(prep.markA);
    const flatB = flattenForBake(prep.markB);

    const texA = this.allocBakeTexture(device);
    const texB = this.allocBakeTexture(device);
    const pathIdxA = this.allocBakeTexture(device);
    const pathIdxB = this.allocBakeTexture(device);
    this.runBakeSegments(
      device, texA, flatA.segments, flatA.pathEnds, fillRuleCode,
      flatA.pathModes, flatA.pathHalfW, 0,
    );
    this.runBakeSegments(
      device, pathIdxA, flatA.segments, flatA.pathEnds, fillRuleCode,
      flatA.pathModes, flatA.pathHalfW, 1,
    );
    this.runBakeSegments(
      device, texB, flatB.segments, flatB.pathEnds, fillRuleCode,
      flatB.pathModes, flatB.pathHalfW, 0,
    );
    this.runBakeSegments(
      device, pathIdxB, flatB.segments, flatB.pathEnds, fillRuleCode,
      flatB.pathModes, flatB.pathHalfW, 1,
    );
    this.morphTexA = texA;
    this.morphTexB = texB;
    this.morphPathIdxTexA = pathIdxA;
    this.morphPathIdxTexB = pathIdxB;

    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.sampler = sampler;
    this.nearestSampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    if (backdrop) {
      // Glass+morph composition: skip the dedicated morph render
      // pipeline and route the morph SDFs through the glass shader's
      // dynamic-SDF mode. Shape A becomes the glass program's `tex0`
      // (the slot the existing per-path glass code reads in its
      // dynamic-SDF branch); shape B binds to the dedicated `sdfB`
      // slot. Per-path slots 1..15 remain bound to a 1×1 dummy that
      // the shader never samples (gated on `dynamicSdf`).
      this.dummyTexture = device.createTexture({
        size: [1, 1],
        format: 'r16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      {
        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
          colorAttachments: [{
            view: this.dummyTexture.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          }],
        });
        pass.end();
        device.queue.submit([enc.finish()]);
      }

      this.textures = [texA];
      const viewFor = (i: number) =>
        (i < this.textures.length ? this.textures[i]! : this.dummyTexture!).createView();
      this.initGlass(device, sampler, backdrop, viewFor);
      return;
    }

    this.morphUniformBuffer = device.createBuffer({
      size: WEBGPU_MORPH_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const morphShader = device.createShaderModule({ code: WEBGPU_MORPH_SHADER });
    const morphLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        {
          binding: WEBGPU_MORPH_SDF_A_BINDING,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: WEBGPU_MORPH_SDF_B_BINDING,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: WEBGPU_MORPH_PATH_IDX_A_BINDING,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: WEBGPU_MORPH_PATH_IDX_B_BINDING,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: WEBGPU_MORPH_NEAREST_SAMPLER_BINDING,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'non-filtering' },
        },
      ],
    });
    this.morphPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [morphLayout] }),
      vertex: { module: morphShader, entryPoint: 'vs_main' },
      fragment: {
        module: morphShader,
        entryPoint: 'fs_main',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.morphBindGroup = device.createBindGroup({
      layout: morphLayout,
      entries: [
        { binding: 0, resource: { buffer: this.morphUniformBuffer } },
        { binding: 1, resource: sampler },
        { binding: WEBGPU_MORPH_SDF_A_BINDING, resource: texA.createView() },
        { binding: WEBGPU_MORPH_SDF_B_BINDING, resource: texB.createView() },
        { binding: WEBGPU_MORPH_PATH_IDX_A_BINDING, resource: pathIdxA.createView() },
        { binding: WEBGPU_MORPH_PATH_IDX_B_BINDING, resource: pathIdxB.createView() },
        { binding: WEBGPU_MORPH_NEAREST_SAMPLER_BINDING, resource: this.nearestSampler! },
      ],
    });
  }

  private initGlass(
    device: GPUDevice,
    sampler: GPUSampler,
    backdrop: TexImageSource,
    viewFor: (i: number) => GPUTextureView,
  ): void {
    const [bw, bh] = textureSourceSize(backdrop);
    if (!bw || !bh) {
      throw new Error('liquid-glass: backdrop has zero size (not loaded yet?)');
    }

    // Backdrop texture — rgba8unorm handles photos/gradients just fine.
    const backdropTexture = device.createTexture({
      size: [bw, bh],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      { source: backdrop, flipY: false },
      { texture: backdropTexture },
      [bw, bh, 1],
    );
    this.backdropTexture = backdropTexture;

    const glassUniformBuffer = device.createBuffer({
      size: WEBGPU_GLASS_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.glassUniformBuffer = glassUniformBuffer;

    const glassShader = device.createShaderModule({ code: WEBGPU_GLASS_SHADER });
    const glassLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ...Array.from({ length: MAX_PATHS }, (_, i) => ({
          binding: SDF_BINDING_START + i,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
        })),
        {
          binding: WEBGPU_BACKDROP_BINDING,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          // Dynamic-SDF "shape B" slot. In glass+morph composition this
          // holds shape B's combined SDF; in plain glass mode it's
          // bound to the 1×1 dummy and never sampled (the shader gates
          // reads on `dynamicSdf`). The slot exists in the layout
          // either way so the bind group is shape-stable across modes.
          binding: WEBGPU_DYNAMIC_SDF_B_BINDING,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          // Path-index map for shape A (glass+morph per-path tinting).
          // Plain glass binds the 1×1 dummy; the shader gates reads on
          // `dynamicSdf`.
          binding: WEBGPU_PATH_IDX_A_BINDING,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: WEBGPU_PATH_IDX_B_BINDING,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: WEBGPU_GLASS_NEAREST_SAMPLER_BINDING,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'non-filtering' },
        },
      ],
    });
    this.glassBindGroupLayout = glassLayout;
    this.glassPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [glassLayout] }),
      vertex: { module: glassShader, entryPoint: 'vs_main' },
      fragment: {
        module: glassShader,
        entryPoint: 'fs_main',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.glassBindGroup = this.buildGlassBindGroup(device, viewFor, backdropTexture);
  }

  private buildGlassBindGroup(
    device: GPUDevice,
    viewFor: (i: number) => GPUTextureView,
    backdropTexture: GPUTexture,
  ): GPUBindGroup {
    // Shape-B and path-index views: real morph textures if the renderer
    // was init'd with a morph target (glass+morph composition), otherwise
    // the 1×1 dummy. The shader gates samples on `dynamicSdf` so the
    // dummies are never read in plain glass mode.
    const sdfBView = (this.morphTexB ?? this.dummyTexture)!.createView();
    const pathIdxAView = (this.morphPathIdxTexA ?? this.dummyTexture)!.createView();
    const pathIdxBView = (this.morphPathIdxTexB ?? this.dummyTexture)!.createView();
    return device.createBindGroup({
      layout: this.glassBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.glassUniformBuffer! } },
        { binding: 1, resource: this.sampler! },
        ...Array.from({ length: MAX_PATHS }, (_, i) => ({
          binding: SDF_BINDING_START + i,
          resource: viewFor(i),
        })),
        { binding: WEBGPU_BACKDROP_BINDING, resource: backdropTexture.createView() },
        { binding: WEBGPU_DYNAMIC_SDF_B_BINDING, resource: sdfBView },
        { binding: WEBGPU_PATH_IDX_A_BINDING, resource: pathIdxAView },
        { binding: WEBGPU_PATH_IDX_B_BINDING, resource: pathIdxBView },
        { binding: WEBGPU_GLASS_NEAREST_SAMPLER_BINDING, resource: this.nearestSampler! },
      ],
    });
  }

  private allocBakeTexture(device: GPUDevice): GPUTexture {
    return device.createTexture({
      size: [WEBGPU_BAKE_SIZE, WEBGPU_BAKE_SIZE],
      format: 'r16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  /**
   * Upload `path.segments` into a transient storage buffer, run the bake
   * fragment program into `texture`. The texture is reused across rebakes.
   * The segment buffer is recreated each call — at 32 bytes per segment
   * it's a sub-KB allocation, cheaper to recreate than to track mapping.
   */
  private runBakeIntoTexture(
    device: GPUDevice,
    texture: GPUTexture,
    path: Path,
  ): void {
    // See initMorph note: per-path baking uses fill mode regardless of
    // path.mode because the sample shader handles strokes via abs(d).
    this.runBakeSegments(device, texture, path.segments, [path.segments.length], 0, [0], [0]);
  }

  private runBakeSegments(
    device: GPUDevice,
    texture: GPUTexture,
    segs: readonly CubicSegment[],
    pathEnds: readonly number[],
    fillRule: number,
    pathModes: readonly number[],
    pathHalfW: readonly number[],
    outputMode: number = 0,
  ): void {
    const pipeline = this.bakePipeline;
    const layout = this.bakeBindGroupLayout;
    if (!pipeline || !layout) return;

    const segFloats = new Float32Array(segs.length * 8);
    for (let i = 0; i < segs.length; i++) {
      segFloats.set(segs[i] as unknown as ArrayLike<number>, i * 8);
    }
    const segmentBuffer = device.createBuffer({
      size: Math.max(segFloats.byteLength, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(segmentBuffer.getMappedRange()).set(segFloats);
    segmentBuffer.unmap();

    // Bake uniforms: pathCount (u32), fillRule (u32), outputMode (u32),
    // pad (u32), then pathEnds / pathMode / pathHalfW each packed four-
    // wide into MAX_PATHS/4 vec4 slots. Layout mirrors WGSL's BakeParams
    // struct. outputMode dispatches the fragment shader between the
    // signed-distance pass (0) and the path-index pass (1) — same
    // pipeline, two draws per side at init.
    const bakeUniformBuffer = device.createBuffer({
      size: WEBGPU_BAKE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    {
      const view = new DataView(bakeUniformBuffer.getMappedRange());
      view.setUint32(WEBGPU_BAKE_OFFSETS.pathCount,  pathEnds.length, true);
      view.setUint32(WEBGPU_BAKE_OFFSETS.fillRule,   fillRule,        true);
      view.setUint32(WEBGPU_BAKE_OFFSETS.outputMode, outputMode,      true);
      for (let i = 0; i < MAX_PATHS; i++) {
        view.setUint32(WEBGPU_BAKE_OFFSETS.pathEnds  + i * 4, pathEnds[i]  ?? 0, true);
        view.setUint32(WEBGPU_BAKE_OFFSETS.pathMode  + i * 4, pathModes[i] ?? 0, true);
        view.setFloat32(WEBGPU_BAKE_OFFSETS.pathHalfW + i * 4, pathHalfW[i] ?? 0, true);
      }
    }
    bakeUniformBuffer.unmap();

    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: segmentBuffer } },
        { binding: 1, resource: { buffer: bakeUniformBuffer } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    segmentBuffer.destroy();
    bakeUniformBuffer.destroy();
  }

  rebake(mark: Mark): void {
    const device = this.device;
    if (!device || this.disposed || !this.bakePipeline) return;
    if (mark.paths.length !== this.textures.length) {
      throw new Error(
        `rebake: mark has ${mark.paths.length} paths but renderer was init'd with ${this.textures.length}`,
      );
    }
    validateMark(mark, MAX_PATHS, MAX_SEGMENTS_PER_SHAPE);
    for (let i = 0; i < mark.paths.length; i++) {
      this.runBakeIntoTexture(device, this.textures[i]!, mark.paths[i]!);
    }
  }

  setBackdrop(source: TexImageSource): void {
    const device = this.device;
    if (!device || this.disposed) return;
    // No glass pipeline was compiled (no backdrop at init) → nothing to
    // update. Callers can't upgrade a non-glass renderer to glass without
    // a re-init.
    if (!this.glassBindGroupLayout || !this.sampler) return;

    const [bw, bh] = textureSourceSize(source);
    if (!bw || !bh) return;

    const old = this.backdropTexture;
    // Texture dims are fixed at creation; always allocate a new one rather
    // than try to detect same-size updates. Cheap, and same-size is the
    // rare case (caller triggers setBackdrop on *size change*).
    const next = device.createTexture({
      size: [bw, bh],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      { source, flipY: false },
      { texture: next },
      [bw, bh, 1],
    );
    this.backdropTexture = next;

    const viewFor = (i: number) =>
      (i < this.textures.length ? this.textures[i]! : this.dummyTexture!).createView();
    this.glassBindGroup = this.buildGlassBindGroup(device, viewFor, next);

    old?.destroy();
  }

  render(u: Uniforms): void {
    const { device, context } = this;
    if (!device || !context || this.disposed) return;

    if (u.morph && this.morphPipeline && this.morphBindGroup && this.morphUniformBuffer) {
      this.renderMorph(device, context, u);
      return;
    }

    // Glass branch is checked before the sample-pipeline guard because
    // glass+morph init compiles only the glass pipeline (no sample), so
    // a samplePipeline-null guard up here would block valid glass draws.
    if (u.glass && this.glassPipeline && this.glassBindGroup && this.glassUniformBuffer) {
      this.renderGlass(device, context, u);
      return;
    }

    const { samplePipeline, uniformBuffer, sampleBindGroup } = this;
    if (!samplePipeline || !uniformBuffer || !sampleBindGroup) return;

    const perPath =
      u.pathModes !== undefined ||
      u.pathFillColors !== undefined ||
      u.pathStrokeColors !== undefined ||
      u.pathStrokeHalfW !== undefined;

    const view = new DataView(this.uniformData);
    // Zero-fill between writes so stale data from prior frames doesn't
    // leak (e.g. ripple slots that weren't re-populated).
    new Uint8Array(this.uniformData).fill(0);
    const off = WEBGPU_SAMPLE_OFFSETS;

    view.setFloat32(off.resolution,     u.width,    true);
    view.setFloat32(off.resolution + 4, u.height,   true);
    view.setFloat32(off.zoom,           u.zoom,     true);
    view.setFloat32(off.sminK,          u.sminK,    true);
    view.setFloat32(off.offset,         u.offsetX,  true);
    view.setFloat32(off.offset + 4,     u.offsetY,  true);
    view.setUint32 (off.compositeMode,  perPath ? 1 : 0, true);
    view.setUint32 (off.pathCount,      this._pathCount, true);
    view.setFloat32(off.color,          u.color[0], true);
    view.setFloat32(off.color + 4,      u.color[1], true);
    view.setFloat32(off.color + 8,      u.color[2], true);
    view.setFloat32(off.opacity,        u.opacity,  true);
    view.setFloat32(off.bound,          1.2,        true); // WEBGPU_BAKE_BOUND
    const cursor = u.cursor ?? [0, 0];
    view.setFloat32(off.cursor,         cursor[0], true);
    view.setFloat32(off.cursor + 4,     cursor[1], true);
    view.setFloat32(off.cursorPull,     u.cursorPull ?? 0, true);
    view.setFloat32(off.cursorRadius,   u.cursorRadius ?? 1, true);

    writeRipples(view, off.ripples, u.ripples);
    writePathOffsets(view, off.pathOffsets, u.pathOffsets);

    if (perPath) {
      writePathModes(view, off.pathMode, u.pathModes);
      writePackedScalars(view, off.pathStrokeHalfW, u.pathStrokeHalfW, 0);
      writePackedScalars(view, off.pathFillOpacity, u.pathFillOpacity, 1);
      writePackedScalars(view, off.pathStrokeOpacity, u.pathStrokeOpacity, 1);
      writePathColors(view, off.pathFillColor, u.pathFillColors);
      writePathColors(view, off.pathStrokeColor, u.pathStrokeColors);
    }

    device.queue.writeBuffer(uniformBuffer, 0, this.uniformData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(samplePipeline);
    pass.setBindGroup(0, sampleBindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  private renderMorph(device: GPUDevice, context: GPUCanvasContext, u: Uniforms): void {
    const pipeline = this.morphPipeline!;
    const bindGroup = this.morphBindGroup!;
    const buffer = this.morphUniformBuffer!;
    const m = u.morph!;

    const view = new DataView(this.morphUniformData);
    new Uint8Array(this.morphUniformData).fill(0);
    const off = WEBGPU_MORPH_OFFSETS;

    view.setFloat32(off.resolution,     u.width,   true);
    view.setFloat32(off.resolution + 4, u.height,  true);
    view.setFloat32(off.zoom,           u.zoom,    true);
    view.setFloat32(off.morphT,         m.t,       true);
    view.setFloat32(off.offset,         u.offsetX, true);
    view.setFloat32(off.offset + 4,     u.offsetY, true);
    view.setFloat32(off.opacity,        u.opacity, true);
    view.setFloat32(off.bound,          WEBGPU_BAKE_BOUND, true);
    view.setFloat32(off.colorA,         m.colorA[0], true);
    view.setFloat32(off.colorA + 4,     m.colorA[1], true);
    view.setFloat32(off.colorA + 8,     m.colorA[2], true);
    view.setFloat32(off.colorB,         m.colorB[0], true);
    view.setFloat32(off.colorB + 4,     m.colorB[1], true);
    view.setFloat32(off.colorB + 8,     m.colorB[2], true);

    // Per-path color arrays. Caller passes them ⇒ unset the override
    // flag and write the array; otherwise the override stays at 1 and
    // colorA/colorB drive the side as a flat color (back-compat with the
    // 2-color morph API).
    const useA = !m.pathColorsA || m.pathColorsA.length === 0;
    const useB = !m.pathColorsB || m.pathColorsB.length === 0;
    view.setUint32(off.useOverrideA, useA ? 1 : 0, true);
    view.setUint32(off.useOverrideB, useB ? 1 : 0, true);
    if (!useA) writePathColors(view, off.pathColorsA, m.pathColorsA!);
    if (!useB) writePathColors(view, off.pathColorsB, m.pathColorsB!);

    device.queue.writeBuffer(buffer, 0, this.morphUniformData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  private renderGlass(device: GPUDevice, context: GPUCanvasContext, u: Uniforms): void {
    const pipeline = this.glassPipeline!;
    const bindGroup = this.glassBindGroup!;
    const buffer = this.glassUniformBuffer!;

    const view = new DataView(this.glassUniformData);
    new Uint8Array(this.glassUniformData).fill(0);
    const off = WEBGPU_GLASS_OFFSETS;

    view.setFloat32(off.resolution,     u.width,   true);
    view.setFloat32(off.resolution + 4, u.height,  true);
    view.setFloat32(off.zoom,           u.zoom,    true);
    view.setFloat32(off.sminK,          u.sminK,   true);
    view.setFloat32(off.offset,         u.offsetX, true);
    view.setFloat32(off.offset + 4,     u.offsetY, true);
    view.setUint32 (off.pathCount,      this._pathCount, true);
    view.setFloat32(off.opacity,        u.opacity, true);
    view.setFloat32(off.refractionStrength, u.refractionStrength ?? GLASS_DEFAULTS.refractionStrength, true);
    view.setFloat32(off.chromaticStrength,  u.chromaticStrength  ?? GLASS_DEFAULTS.chromaticStrength, true);
    view.setFloat32(off.fresnelStrength,    u.fresnelStrength    ?? GLASS_DEFAULTS.fresnelStrength, true);
    view.setFloat32(off.tintStrength,       u.tintStrength       ?? GLASS_DEFAULTS.tintStrength, true);
    const rim = u.rimColor ?? GLASS_DEFAULTS.rimColor;
    view.setFloat32(off.rimColor,     rim[0], true);
    view.setFloat32(off.rimColor + 4, rim[1], true);
    view.setFloat32(off.rimColor + 8, rim[2], true);
    view.setFloat32(off.bound, 1.2, true); // WEBGPU_BAKE_BOUND
    const tint = u.tintColor ?? GLASS_DEFAULTS.tintColor;
    view.setFloat32(off.tintColor,     tint[0], true);
    view.setFloat32(off.tintColor + 4, tint[1], true);
    view.setFloat32(off.tintColor + 8, tint[2], true);
    view.setFloat32(off.frostStrength, u.frostStrength ?? GLASS_DEFAULTS.frostStrength, true);

    const cursor = u.cursor ?? [0, 0];
    view.setFloat32(off.cursor,       cursor[0], true);
    view.setFloat32(off.cursor + 4,   cursor[1], true);
    view.setFloat32(off.cursorPull,   u.cursorPull ?? 0, true);
    view.setFloat32(off.cursorRadius, u.cursorRadius ?? 1, true);
    writeRipples(view, off.ripples, u.ripples);

    // Per-path mode + stroke half-width: stroke paths go through glass as
    // their sausage SDF (abs(d) - halfW) rather than solid silhouettes.
    // Unset → fills, matching legacy single-color smin behaviour.
    writePathModes(view, off.pathMode, u.pathModes);
    writePackedScalars(view, off.pathStrokeHalfW, u.pathStrokeHalfW, 0);
    writePathOffsets(view, off.pathOffsets, u.pathOffsets);

    // Dynamic-SDF mode: when the renderer was init'd with both a backdrop
    // and a morph target, `u.morph.t` drives the per-fragment blend
    // between the two morph-baked SDFs inside the glass shader. In plain
    // glass mode the flag stays 0 and the shader runs its existing
    // per-path smin path.
    const dynamic = !!u.morph && this.morphTexB !== null;
    view.setUint32 (off.dynamicSdf, dynamic ? 1 : 0,    true);
    view.setFloat32(off.blendT,     u.morph?.t ?? 0,    true);

    // Per-path tint plumbing for glass+morph. Mirror of renderMorph
    // above: caller-supplied per-path color arrays switch the shader
    // off the morphColorA/B flat overrides and into texture-based
    // lookup. Plain glass mode forces both overrides to 1 so the
    // shader's per-pixel tint path is gated out and U.tintColor (set
    // earlier in this function) drives the unchanged frosted-glass
    // tint.
    if (dynamic) {
      const m = u.morph!;
      const useA = !m.pathColorsA || m.pathColorsA.length === 0;
      const useB = !m.pathColorsB || m.pathColorsB.length === 0;
      view.setUint32 (off.useOverrideA, useA ? 1 : 0, true);
      view.setUint32 (off.useOverrideB, useB ? 1 : 0, true);
      view.setFloat32(off.morphColorA,     m.colorA[0], true);
      view.setFloat32(off.morphColorA + 4, m.colorA[1], true);
      view.setFloat32(off.morphColorA + 8, m.colorA[2], true);
      view.setFloat32(off.morphColorB,     m.colorB[0], true);
      view.setFloat32(off.morphColorB + 4, m.colorB[1], true);
      view.setFloat32(off.morphColorB + 8, m.colorB[2], true);
      if (!useA) writePathColors(view, off.pathColorsA, m.pathColorsA!);
      if (!useB) writePathColors(view, off.pathColorsB, m.pathColorsB!);
    } else {
      view.setUint32(off.useOverrideA, 1, true);
      view.setUint32(off.useOverrideB, 1, true);
    }

    device.queue.writeBuffer(buffer, 0, this.glassUniformData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.uniformBuffer?.destroy();
    this.glassUniformBuffer?.destroy();
    this.morphUniformBuffer?.destroy();
    this.textures.forEach((t) => t.destroy());
    this.dummyTexture?.destroy();
    this.backdropTexture?.destroy();
    this.morphTexA?.destroy();
    this.morphTexB?.destroy();
    this.morphPathIdxTexA?.destroy();
    this.morphPathIdxTexB?.destroy();
    this.context?.unconfigure();
    this.device?.destroy();
    this.uniformBuffer = null;
    this.glassUniformBuffer = null;
    this.morphUniformBuffer = null;
    this.textures = [];
    this.dummyTexture = null;
    this.backdropTexture = null;
    this.morphTexA = null;
    this.morphTexB = null;
    this.morphPathIdxTexA = null;
    this.morphPathIdxTexB = null;
    this.context = null;
    this.device = null;
    this.samplePipeline = null;
    this.sampleBindGroup = null;
    this.bakePipeline = null;
    this.bakeBindGroupLayout = null;
    this.glassPipeline = null;
    this.glassBindGroup = null;
    this.glassBindGroupLayout = null;
    this.morphPipeline = null;
    this.morphBindGroup = null;
    this.sampler = null;
    this.nearestSampler = null;
  }
}

/**
 * Concatenate every path's segments into one array and produce the
 * cumulative `pathEnds[i]` (exclusive end indices), per-path render
 * modes, and per-path stroke half-widths the bake shader needs to walk
 * the combined buffer with the correct per-path semantics. Stroked
 * paths (mode === 'stroke') bake as sausage SDFs; fills and 'both' use
 * even-odd parity. Mirrors the WebGL helper in WebGLRenderer.ts.
 */
function flattenForBake(mark: Mark): {
  segments: CubicSegment[];
  pathEnds: number[];
  pathModes: number[];
  pathHalfW: number[];
} {
  const segments: CubicSegment[] = [];
  const pathEnds: number[] = [];
  const pathModes: number[] = [];
  const pathHalfW: number[] = [];
  for (const p of mark.paths) {
    for (const s of p.segments) segments.push(s);
    pathEnds.push(segments.length);
    pathModes.push(p.mode === 'stroke' ? 1 : 0);
    pathHalfW.push(p.mode === 'fill' ? 0 : p.strokeWidth * 0.5);
  }
  return { segments, pathEnds, pathModes, pathHalfW };
}

/**
 * Validate that a flattened morph side fits the bake shader's combined
 * loop bound. Throws with a clear message at init time so users hit it
 * before getContext binds the canvas (clean fallback path).
 */
function validateCombined(mark: Mark, label: 'A' | 'B'): void {
  let total = 0;
  for (const p of mark.paths) total += p.segments.length;
  if (total > MAX_SEGMENTS_PER_SHAPE) {
    throw new Error(
      `morph shape ${label} has ${total} combined segments but the bake shader's per-shape cap is ${MAX_SEGMENTS_PER_SHAPE}. ` +
        'Simplify the source SVG (Inkscape → Path → Simplify) or merge duplicate paths.',
    );
  }
}

/* --- Uniform-write helpers ----------------------------------------------- */
// These live outside the class so both render paths share the packing rules
// and can't drift apart. All take base offsets computed from the shader's
// struct layout in WEBGPU_SAMPLE_OFFSETS / WEBGPU_GLASS_OFFSETS.

function writeRipples(
  view: DataView,
  base: number,
  ripples: ReadonlyArray<readonly [number, number, number, number]> | undefined,
): void {
  for (let i = 0; i < 4; i++) {
    const r = ripples?.[i];
    const o = base + i * 16;
    view.setFloat32(o,      r ? r[0] : 0, true);
    view.setFloat32(o + 4,  r ? r[1] : 0, true);
    view.setFloat32(o + 8,  r ? r[2] : 0, true);
    view.setFloat32(o + 12, r ? r[3] : 0, true);
  }
}

/** Pack two vec2 offsets into each vec4 slot: (x0,y0,x1,y1), (x2,y2,x3,y3)… */
function writePathOffsets(
  view: DataView,
  base: number,
  offsets: ReadonlyArray<readonly [number, number]>,
): void {
  for (let i = 0; i < MAX_PATHS; i++) {
    const o = offsets[i];
    const slot = i >> 1;
    const sub = (i & 1) * 8;
    const byte = base + slot * 16 + sub;
    view.setFloat32(byte,     o ? o[0] : 0, true);
    view.setFloat32(byte + 4, o ? o[1] : 0, true);
  }
}

/** Pack 16 per-path mode codes (fill=0/stroke=1/both=2) four per vec4<u32>. */
function writePathModes(
  view: DataView,
  base: number,
  modes: ReadonlyArray<'fill' | 'stroke' | 'both'> | undefined,
): void {
  for (let i = 0; i < MAX_PATHS; i++) {
    const m = modes?.[i];
    const v = m === 'stroke' ? 1 : m === 'both' ? 2 : 0;
    view.setUint32(base + i * 4, v, true);
  }
}

/** Pack 16 floats four per vec4, with a default used for missing entries. */
function writePackedScalars(
  view: DataView,
  base: number,
  src: ReadonlyArray<number> | undefined,
  fallback: number,
): void {
  for (let i = 0; i < MAX_PATHS; i++) {
    view.setFloat32(base + i * 4, src?.[i] ?? fallback, true);
  }
}

/** Write 16 RGB colors into their padded vec4 slots (.rgb set, .a=0). */
function writePathColors(
  view: DataView,
  base: number,
  src: ReadonlyArray<RgbColor> | undefined,
): void {
  for (let i = 0; i < MAX_PATHS; i++) {
    const c = src?.[i];
    const o = base + i * 16;
    view.setFloat32(o,     c?.[0] ?? 0, true);
    view.setFloat32(o + 4, c?.[1] ?? 0, true);
    view.setFloat32(o + 8, c?.[2] ?? 0, true);
  }
}
