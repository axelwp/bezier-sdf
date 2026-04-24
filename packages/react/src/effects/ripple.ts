import type { EffectDefinition, EffectRuntime } from './types';

/**
 * Tuning lifted from examples/liquid-cursor. The shader subtracts a
 * Gaussian ring centered on the click point; we grow its radius with time
 * (`age * speed`) and fade its amplitude exponentially. Lifetime is driven
 * by the amplitude envelope falling below `EPSILON`, so `decay` governs
 * how long a ring lives and `speed` only governs how fast it travels.
 */
export interface RippleParams {
  /** Radial growth rate of the ring (SDF units / second). */
  speed?: number;
  /** Peak SDF deformation at the ring crest. */
  amplitude?: number;
  /** Exponential fade rate; higher = quicker decay (and shorter lifetime). */
  decay?: number;
  /** Optional hard ceiling in seconds. When set, rings are culled no later than this. */
  duration?: number;
}

const DEFAULTS = {
  speed: 2.8,
  amplitude: 0.08,
  decay: 3.5,
};

/** Amplitude (in SDF units) below which a ring is considered invisible. */
const EPSILON = 1e-3;

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
    let amplitude = initial?.amplitude ?? DEFAULTS.amplitude;
    let decay = initial?.decay ?? DEFAULTS.decay;
    let duration: number | undefined = initial?.duration;

    const slots: (Ring | null)[] = [null, null, null, null];
    let nextSlot = 0;

    // Age at which the amplitude envelope crosses EPSILON: amplitude * exp(-age * decay) = EPSILON.
    const envelopeLifetime = () =>
      amplitude <= EPSILON || decay <= 0 ? 0 : Math.log(amplitude / EPSILON) / decay;
    const lifetime = () => {
      const env = envelopeLifetime();
      return typeof duration === 'number' ? Math.min(env, duration) : env;
    };

    const uniformFor = (r: Ring | null, now: number): readonly [number, number, number, number] => {
      if (!r) return DEAD;
      const age = (now - r.startMs) / 1000;
      if (age < 0 || age > lifetime()) return DEAD;
      return [r.x, r.y, age * speed, amplitude * Math.exp(-age * decay)];
    };

    return {
      frame(now) {
        return { ripples: slots.map((r) => uniformFor(r, now)) };
      },
      active(now) {
        const life = lifetime();
        for (const r of slots) {
          if (r && (now - r.startMs) / 1000 < life) return true;
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
        if (typeof rp.amplitude === 'number') amplitude = rp.amplitude;
        if (typeof rp.decay === 'number') decay = rp.decay;
        if (typeof rp.duration === 'number') duration = rp.duration;
      },
    };
  },
};
