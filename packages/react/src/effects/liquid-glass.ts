/**
 * Tuning for the liquid-glass material. Unlike the other effects in this
 * folder, liquid-glass isn't a frame-based runtime — it's a *material*:
 * a different sample shader with its own uniforms. The component routes
 * to a separate render path when this material is active.
 *
 * Starting values are tuned against a few varied backdrops (gradients,
 * photos, solid colors) and produce a recognizably glass-like lens
 * without looking fake. Crank `refractionStrength` and `chromaticStrength`
 * to exaggerate; lean on `tintStrength` to push toward a colored glass.
 *
 * See `packages/core/src/shaders/webgl.ts :: WEBGL_GLASS_FRAG` for the
 * full ingredient list and what each knob does.
 *
 *   refractionStrength — peak inward displacement of the backdrop sample,
 *                        in normalized SDF units.
 *   chromaticStrength  — relative magnitude of the R/B offset vs G,
 *                        scalar in `[0, ~0.1]`. Produces the rainbow
 *                        fringe on curves.
 *   fresnelStrength    — additive intensity of the rim band along the
 *                        shape's edge.
 *   tintStrength       — mixing weight of `tintColor` across the
 *                        interior, scaled by depth-in-shape.
 *   frostStrength      — radius (in physical pixels) of the cross-blur
 *                        applied across the interior to give the lens a
 *                        subtle frosted quality. `0` → perfectly clear
 *                        interior; `~2–4` → Apple-style liquid glass.
 *   rimColor / tintColor — CSS color strings. Default rim is white; tint
 *                          is a very pale cool white.
 */
export interface LiquidGlassParams {
  refractionStrength?: number;
  chromaticStrength?: number;
  fresnelStrength?: number;
  tintStrength?: number;
  frostStrength?: number;
  rimColor?: string;
  tintColor?: string;
}

export const DEFAULT_GLASS_PARAMS = {
  refractionStrength: 0.05,
  chromaticStrength: 0.015,
  fresnelStrength: 0.3,
  tintStrength: 0.1,
  frostStrength: 2.5,
  rimColor: '#ffffff',
  tintColor: '#e8f0ff',
} as const;
