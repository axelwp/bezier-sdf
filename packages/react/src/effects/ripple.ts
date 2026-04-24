import type { EffectDefinition, EffectRuntime } from './types';

/**
 * Tuning lifted from examples/liquid-cursor. The shader subtracts a
 * Gaussian ring centered on the click point; we grow its radius with time
 * (`age * speed`) and fade its amplitude exponentially.
 */
export interface RippleParams {
  /** Radial growth rate of the ring (SDF units / second). */
  speed?: number;
  /** Seconds before the ring is culled. */
  duration?: number;
  /** Peak SDF deformation at the ring crest. */
  amplitude?: number;
  /** Exponential fade rate; higher = quicker decay. */
  decay?: number;
}

const DEFAULTS = {
  speed: 2.8,
  duration: 0.9,
  amplitude: 0.08,
  decay: 3.5,
};

type Ring = { x: number; y: number; startMs: number };
const DEAD: readonly [number, number, number, number] = [0, 0, 0, 0];

/**
 * Click-to-ripple. Each pointerdown seeds a ring in a 4-slot buffer (the
 * renderer's hard cap); when all slots are full, the oldest is evicted.
 */
export const ripple: EffectDefinition = {
  name: 'ripple',
  needsPointer: true,
  scrollTrigger: false,
  create({ reducedMotion, params }): EffectRuntime {
    const initial = params as RippleParams | undefined;
    let speed = initial?.speed ?? DEFAULTS.speed;
    let duration = initial?.duration ?? DEFAULTS.duration;
    let amplitude = initial?.amplitude ?? DEFAULTS.amplitude;
    let decay = initial?.decay ?? DEFAULTS.decay;

    const slots: (Ring | null)[] = [null, null, null, null];
    let nextSlot = 0;

    const uniformFor = (r: Ring | null, now: number): readonly [number, number, number, number] => {
      if (!r) return DEAD;
      const age = (now - r.startMs) / 1000;
      if (age < 0 || age > duration) return DEAD;
      return [r.x, r.y, age * speed, amplitude * Math.exp(-age * decay)];
    };

    return {
      frame(now) {
        return { ripples: slots.map((r) => uniformFor(r, now)) };
      },
      active(now) {
        for (const r of slots) {
          if (r && (now - r.startMs) / 1000 < duration) return true;
        }
        return false;
      },
      pointerDown(x, y, now) {
        if (reducedMotion) return;
        slots[nextSlot] = { x, y, startMs: now };
        nextSlot = (nextSlot + 1) % slots.length;
      },
      setParams(p) {
        const rp = p as RippleParams;
        if (typeof rp.speed === 'number') speed = rp.speed;
        if (typeof rp.duration === 'number') duration = rp.duration;
        if (typeof rp.amplitude === 'number') amplitude = rp.amplitude;
        if (typeof rp.decay === 'number') decay = rp.decay;
      },
    };
  },
};
