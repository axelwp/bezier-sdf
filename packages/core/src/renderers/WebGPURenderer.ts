import type { Mark, Path } from '../geometry/types';
import {
  WEBGPU_BAKE_SHADER,
  WEBGPU_BAKE_SIZE,
  WEBGPU_SAMPLE_SHADER,
} from '../shaders/webgpu';
import { type Renderer, type RendererInitOptions, type Uniforms, validateMark } from './types';

const MAX_PATHS = 4;
// MAX_SEGS isn't enforced by WebGPU's dynamic storage buffer — it's just
// the documented upper bound matching the WebGL shader.
const MAX_SEGS = 32;

/**
 * Uniform buffer layout — matches the WGSL `Uniforms` struct in
 * shaders/webgpu.ts. Offsets are computed per the WGSL alignment rules
 * (vec3<f32> has align 16 / size 12; array<vec4> has 16-byte stride).
 *
 *   resolution      : vec2<f32>        // 0   (8)
 *   zoom            : f32              // 8   (4)
 *   sminK           : f32              // 12  (4)
 *   offset          : vec2<f32>        // 16  (8)
 *   compositeMode   : u32              // 24  (4)
 *   _pad0           : u32              // 28  (4)
 *   pathOffset0..3  : vec2<f32>[4]     // 32  (32)
 *   color           : vec3<f32>        // 64  (12)
 *   opacity         : f32              // 76  (4)
 *   bound           : f32              // 80  (4)
 *   pathCount       : u32              // 84  (4)
 *   cursor          : vec2<f32>        // 88  (8)
 *   cursorPull      : f32              // 96  (4)
 *   cursorRadius    : f32              // 100 (4)
 *   _padR           : vec2<f32>        // 104 (8)
 *   ripples[0..3]   : vec4<f32>[4]     // 112 (64)
 *   pathMode        : vec4<u32>        // 176 (16)
 *   pathStrokeHalfW : vec4<f32>        // 192 (16)
 *   pathFillOpacity : vec4<f32>        // 208 (16)
 *   pathStrokeOpacity:vec4<f32>        // 224 (16)
 *   pathFillColor   : vec4<f32>[4]     // 240 (64)
 *   pathStrokeColor : vec4<f32>[4]     // 304 (64)
 * Total: 368 bytes, 16-aligned.
 */
const UNIFORM_BUFFER_SIZE = 368;

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
  private uniformData = new ArrayBuffer(UNIFORM_BUFFER_SIZE);
  private _pathCount = 0;
  private disposed = false;

  readonly mode = 'baked' as const;
  get pathCount(): number { return this._pathCount; }

  async init({ canvas, mark }: RendererInitOptions): Promise<void> {
    validateMark(mark, MAX_PATHS, MAX_SEGS);
    this._pathCount = mark.paths.length;

    if (!('gpu' in navigator) || !navigator.gpu) {
      throw new Error('WebGPU not available');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
    if (!adapter) throw new Error('no WebGPU adapter');
    const device = await adapter.requestDevice();
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

    // Dummy 1x1 texture for unused path slots — WebGPU requires all four
    // texture bindings even when pathCount < 4.
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
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const sampleShader = device.createShaderModule({ code: WEBGPU_SAMPLE_SHADER });
    const sampleBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
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
        { binding: 2, resource: viewFor(0) },
        { binding: 3, resource: viewFor(1) },
        { binding: 4, resource: viewFor(2) },
        { binding: 5, resource: viewFor(3) },
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

  render(u: Uniforms): void {
    const { device, context, samplePipeline, uniformBuffer, sampleBindGroup } = this;
    if (!device || !context || !samplePipeline || !uniformBuffer || !sampleBindGroup || this.disposed) return;

    const perPath =
      u.pathModes !== undefined ||
      u.pathFillColors !== undefined ||
      u.pathStrokeColors !== undefined ||
      u.pathStrokeHalfW !== undefined;

    const view = new DataView(this.uniformData);
    // Zero-fill between writes so stale data from prior frames doesn't
    // leak (e.g. ripple slots that weren't re-populated).
    new Uint8Array(this.uniformData).fill(0);

    view.setFloat32(0,  u.width,    true);
    view.setFloat32(4,  u.height,   true);
    view.setFloat32(8,  u.zoom,     true);
    view.setFloat32(12, u.sminK,    true);
    view.setFloat32(16, u.offsetX,  true);
    view.setFloat32(20, u.offsetY,  true);
    view.setUint32(24, perPath ? 1 : 0, true);
    // 28: _pad0

    const writeOff = (slot: number, off?: readonly [number, number]) => {
      const base = 32 + slot * 8;
      view.setFloat32(base,     off ? off[0] : 0, true);
      view.setFloat32(base + 4, off ? off[1] : 0, true);
    };
    writeOff(0, u.pathOffsets[0]);
    writeOff(1, u.pathOffsets[1]);
    writeOff(2, u.pathOffsets[2]);
    writeOff(3, u.pathOffsets[3]);
    view.setFloat32(64, u.color[0], true);
    view.setFloat32(68, u.color[1], true);
    view.setFloat32(72, u.color[2], true);
    view.setFloat32(76, u.opacity,  true);
    view.setFloat32(80, 1.2,        true); // bound (matches shader constant)
    view.setUint32(84, this._pathCount, true);
    const cursor = u.cursor ?? [0, 0];
    view.setFloat32(88, cursor[0], true);
    view.setFloat32(92, cursor[1], true);
    view.setFloat32(96, u.cursorPull ?? 0, true);
    view.setFloat32(100, u.cursorRadius ?? 1, true);
    // ripples[0..3] at 112..176.
    const ripples = u.ripples;
    for (let i = 0; i < 4; i++) {
      const r = ripples?.[i];
      const base = 112 + i * 16;
      view.setFloat32(base,      r ? r[0] : 0, true);
      view.setFloat32(base + 4,  r ? r[1] : 0, true);
      view.setFloat32(base + 8,  r ? r[2] : 0, true);
      view.setFloat32(base + 12, r ? r[3] : 0, true);
    }

    if (perPath) {
      const modes = u.pathModes ?? [];
      for (let i = 0; i < 4; i++) {
        const m = modes[i];
        const v = m === 'stroke' ? 1 : m === 'both' ? 2 : 0;
        view.setUint32(176 + i * 4, v, true);
      }
      const halfW = u.pathStrokeHalfW ?? [];
      for (let i = 0; i < 4; i++) view.setFloat32(192 + i * 4, halfW[i] ?? 0, true);
      const fo = u.pathFillOpacity ?? [];
      for (let i = 0; i < 4; i++) view.setFloat32(208 + i * 4, fo[i] ?? 1, true);
      const so = u.pathStrokeOpacity ?? [];
      for (let i = 0; i < 4; i++) view.setFloat32(224 + i * 4, so[i] ?? 1, true);
      const fc = u.pathFillColors;
      for (let i = 0; i < 4; i++) {
        const c = fc?.[i];
        const base = 240 + i * 16;
        view.setFloat32(base,      c?.[0] ?? 0, true);
        view.setFloat32(base + 4,  c?.[1] ?? 0, true);
        view.setFloat32(base + 8,  c?.[2] ?? 0, true);
      }
      const sc = u.pathStrokeColors;
      for (let i = 0; i < 4; i++) {
        const c = sc?.[i];
        const base = 304 + i * 16;
        view.setFloat32(base,      c?.[0] ?? 0, true);
        view.setFloat32(base + 4,  c?.[1] ?? 0, true);
        view.setFloat32(base + 8,  c?.[2] ?? 0, true);
      }
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.uniformBuffer?.destroy();
    this.textures.forEach((t) => t.destroy());
    this.dummyTexture?.destroy();
    this.context?.unconfigure();
    this.device?.destroy();
    this.uniformBuffer = null;
    this.textures = [];
    this.dummyTexture = null;
    this.context = null;
    this.device = null;
    this.samplePipeline = null;
    this.sampleBindGroup = null;
    this.bakePipeline = null;
    this.bakeBindGroupLayout = null;
  }
}
