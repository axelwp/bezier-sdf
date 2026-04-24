import type { Mark, Path, RgbColor } from '../geometry/types';
import {
  MAX_PATHS,
  WEBGPU_BACKDROP_BINDING,
  WEBGPU_BAKE_SHADER,
  WEBGPU_BAKE_SIZE,
  WEBGPU_GLASS_OFFSETS,
  WEBGPU_GLASS_SHADER,
  WEBGPU_GLASS_UNIFORM_SIZE,
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

// MAX_SEGS isn't enforced by WebGPU's dynamic storage buffer — it's just
// the documented upper bound matching the WebGL shader.
const MAX_SEGS = 128;

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
  private _pathCount = 0;
  private disposed = false;

  readonly mode = 'baked' as const;
  get pathCount(): number { return this._pathCount; }

  async init({ canvas, mark, backdrop }: RendererInitOptions): Promise<void> {
    validateMark(mark, MAX_PATHS, MAX_SEGS);
    this._pathCount = mark.paths.length;

    if (!('gpu' in navigator) || !navigator.gpu) {
      throw new Error('WebGPU not available');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
    if (!adapter) throw new Error('no WebGPU adapter');
    // Glass binds 16 SDF textures + backdrop = 17 sampled textures in one
    // stage, one past the WebGPU default minimum of 16. Request the extra
    // up front so requestDevice rejects on adapters that can't meet it —
    // clearer than a later pipeline-creation failure. Every desktop GPU
    // driver exposes thousands; the downgrade path only matters on very
    // constrained embedded targets.
    const sampledTextureLimit = backdrop ? MAX_PATHS + 1 : MAX_PATHS;
    const adapterMax = adapter.limits.maxSampledTexturesPerShaderStage;
    if (adapterMax < sampledTextureLimit) {
      throw new Error(
        `adapter exposes maxSampledTexturesPerShaderStage=${adapterMax}; bezier-sdf needs ${sampledTextureLimit} (MAX_PATHS=${MAX_PATHS}${backdrop ? ' + backdrop' : ''})`,
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

    this.textures = mark.paths.map((p) => this.allocBakeTexture(device));
    for (let i = 0; i < mark.paths.length; i++) {
      this.runBakeIntoTexture(device, this.textures[i]!, mark.paths[i]!);
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
   * The segment buffer is recreated each call — at MAX_SEGS×32 bytes it's
   * a sub-KB allocation, cheaper to recreate than to track mapping.
   */
  private runBakeIntoTexture(
    device: GPUDevice,
    texture: GPUTexture,
    path: Path,
  ): void {
    const pipeline = this.bakePipeline;
    const layout = this.bakeBindGroupLayout;
    if (!pipeline || !layout) return;

    const segs = path.segments;
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

    const bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: segmentBuffer } }],
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
  }

  rebake(mark: Mark): void {
    const device = this.device;
    if (!device || this.disposed || !this.bakePipeline) return;
    if (mark.paths.length !== this.textures.length) {
      throw new Error(
        `rebake: mark has ${mark.paths.length} paths but renderer was init'd with ${this.textures.length}`,
      );
    }
    validateMark(mark, MAX_PATHS, MAX_SEGS);
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
    const { device, context, samplePipeline, uniformBuffer, sampleBindGroup } = this;
    if (!device || !context || !samplePipeline || !uniformBuffer || !sampleBindGroup || this.disposed) return;

    if (u.glass && this.glassPipeline && this.glassBindGroup && this.glassUniformBuffer) {
      this.renderGlass(device, context, u);
      return;
    }

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
    this.textures.forEach((t) => t.destroy());
    this.dummyTexture?.destroy();
    this.backdropTexture?.destroy();
    this.context?.unconfigure();
    this.device?.destroy();
    this.uniformBuffer = null;
    this.glassUniformBuffer = null;
    this.textures = [];
    this.dummyTexture = null;
    this.backdropTexture = null;
    this.context = null;
    this.device = null;
    this.samplePipeline = null;
    this.sampleBindGroup = null;
    this.bakePipeline = null;
    this.bakeBindGroupLayout = null;
    this.glassPipeline = null;
    this.glassBindGroup = null;
    this.glassBindGroupLayout = null;
    this.sampler = null;
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
