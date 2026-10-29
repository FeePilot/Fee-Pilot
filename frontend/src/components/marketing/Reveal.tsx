import { motion, type HTMLMotionProps } from 'motion/react';
import { fadeUp, stagger } from '@/lib/motion';

/**
 * Scroll reveal. Starts hidden and shows when it enters the viewport (once). The `data-reveal`
 * attribute lets `.no-js` undo the hidden state, so the prerendered page reads without JavaScript.
 */
export function Reveal({
  delay = 0,
  children,
  ...rest
}: HTMLMotionProps<'div'> & { delay?: number }) {
  return (
    <motion.div
      data-reveal
      variants={fadeUp}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '0px 0px -10% 0px' }}
      transition={delay ? { delay } : undefined}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/** A group whose `RevealItem` children appear one after another. */
export function RevealGroup({
  gap = 0.08,
  children,
  ...rest
}: HTMLMotionProps<'div'> & { gap?: number }) {
  return (
    <motion.div
      data-reveal
      variants={stagger(gap)}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '0px 0px -10% 0px' }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

export function RevealItem({ children, ...rest }: HTMLMotionProps<'div'>) {
  return (
    <motion.div data-reveal variants={fadeUp} {...rest}>
      {children}
    </motion.div>
  );
}
