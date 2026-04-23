import type { EffectDefinition, EffectRuntime } from './types';

/**
 * Tuning lifted from examples/liquid-cursor. The shader subtracts a
 * Gaussian ring centered on the click point; we grow its radius with time
 * (`age * RIPPLE_SPEED`) and fade its amplitude exponentially.
 */
const RIPPLE_SPEED = 2.8;
const RIPPLE_DURATION = 0.9;
const RIPPLE_AMPLITUDE = 0.08;
const RIPPLE_DECAY = 3.5;

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
  create({ reducedMotion }): EffectRuntime {
    const slots: (Ring | null)[] = [null, null, null, null];
    let nextSlot = 0;

    const uniformFor = (r: Ring | null, now: number): readonly [number, number, number, number] => {
      if (!r) return DEAD;
      const age = (now - r.startMs) / 1000;
      if (age < 0 || age > RIPPLE_DURATION) return DEAD;
      return [r.x, r.y, age * RIPPLE_SPEED, RIPPLE_AMPLITUDE * Math.exp(-age * RIPPLE_DECAY)];
    };

    return {
      frame(now) {
        return { ripples: slots.map((r) => uniformFor(r, now)) };
      },
      active(now) {
        for (const r of slots) {
          if (r && (now - r.startMs) / 1000 < RIPPLE_DURATION) return true;
        }
        return false;
      },
      pointerDown(x, y, now) {
        if (reducedMotion) return;
        slots[nextSlot] = { x, y, startMs: now };
        nextSlot = (nextSlot + 1) % slots.length;
      },
    };
  },
};
