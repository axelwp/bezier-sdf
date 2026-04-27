import type { Renderer, RendererInitOptions } from './types';
import { WebGPURenderer } from './WebGPURenderer';
import { WebGLRenderer } from './WebGLRenderer';

export type RendererKind = 'auto' | 'webgpu' | 'webgl';

export interface CreateRendererResult {
  renderer: Renderer;
  /** The backend that was actually instantiated. */
  actualKind: 'webgpu' | 'webgl';
  /** If a preferred backend failed, its error surfaces here for telemetry. */
  fallbackFrom?: { kind: 'webgpu'; error: Error };
}

/**
 * Instantiate the best available renderer.
 *
 *   'auto'   — try WebGPU first, fall back to WebGL silently.
 *   'webgpu' — only try WebGPU; surface any failure to the caller.
 *   'webgl'  — force WebGL. Useful for testing the fallback path.
 *
 * Never creates a canvas itself — the caller passes the one they've
 * already sized. Never throws on the 'auto' path unless *both* backends
 * fail.
 */
export async function createRenderer(
  kind: RendererKind,
  options: RendererInitOptions,
): Promise<CreateRendererResult> {
  if (kind === 'webgl') {
    const r = new WebGLRenderer();
    await r.init(options);
    return { renderer: r, actualKind: 'webgl' };
  }

  const shouldTryGpu = kind === 'webgpu' ||
    (kind === 'auto' && typeof navigator !== 'undefined' && 'gpu' in navigator);

  if (shouldTryGpu) {
    try {
      const r = new WebGPURenderer();
      await r.init(options);
      return { renderer: r, actualKind: 'webgpu' };
    } catch (err) {
      if (kind === 'webgpu') throw err;
      const gpuErr = err instanceof Error ? err : new Error(String(err));
      try {
        const gl = new WebGLRenderer();
        await gl.init(options);
        return {
          renderer: gl,
          actualKind: 'webgl',
          fallbackFrom: { kind: 'webgpu', error: gpuErr },
        };
      } catch (glErr) {
        // Both backends failed. The WebGPU error is almost always the
        // useful one (the WebGL error is often "WebGL not supported" —
        // a side effect of `getContext('webgpu')` having already bound
        // the canvas, which permanently locks out other context types).
        // Surface the WebGPU cause as the primary message and attach the
        // WebGL error as `.cause` for callers that want both.
        const glMessage = glErr instanceof Error ? glErr.message : String(glErr);
        const composite = new Error(
          `WebGPU init failed and WebGL fallback also failed.\n` +
            `  WebGPU: ${gpuErr.message}\n` +
            `  WebGL:  ${glMessage}`,
        );
        // Stash both originals on the composite for callers/devtools.
        // Set via assignment (rather than `new Error(msg, { cause })`)
        // because the project's TS target is ES2020, which doesn't know
        // about the cause option even though all our supported runtimes
        // do.
        (composite as Error & { cause?: unknown }).cause = glErr;
        (composite as Error & { gpuCause?: unknown }).gpuCause = gpuErr;
        throw composite;
      }
    }
  }

  const gl = new WebGLRenderer();
  await gl.init(options);
  return { renderer: gl, actualKind: 'webgl' };
}
