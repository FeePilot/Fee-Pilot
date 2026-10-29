// One set of motion tokens, so every component moves the same way.
// Components import from here instead of writing springs and durations inline.
import type { Transition, Variants } from 'motion/react';

export const spring = {
  /** Panels, modals and layout changes: settles without bounce. */
  soft: {
    type: 'spring',
    stiffness: 260,
    damping: 30,
    mass: 0.9,
  } satisfies Transition,
  /** Small controls: quick and crisp. */
  snappy: { type: 'spring', stiffness: 520, damping: 34 } satisfies Transition,
  /** Hover and press feedback. */
  press: { type: 'spring', stiffness: 700, damping: 40 } satisfies Transition,
} as const;

export const ease = {
  out: [0.22, 1, 0.36, 1] as [number, number, number, number],
  inOut: [0.65, 0, 0.35, 1] as [number, number, number, number],
};

export const duration = { fast: 0.15, base: 0.28, slow: 0.6 } as const;

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: duration.slow, ease: ease.out },
  },
};

export const fade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: duration.base } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 8 },
  show: { opacity: 1, scale: 1, y: 0, transition: spring.soft },
  exit: {
    opacity: 0,
    scale: 0.97,
    y: 4,
    transition: { duration: duration.fast },
  },
};

/** Container that reveals its children one after another. */
export function stagger(gap = 0.07, delay = 0): Variants {
  return {
    hidden: {},
    show: { transition: { staggerChildren: gap, delayChildren: delay } },
  };
}

/** Route transitions: a short fade and lift, so navigation feels continuous. */
export const page: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: duration.base, ease: ease.out },
  },
  exit: { opacity: 0, y: -6, transition: { duration: duration.fast } },
};
