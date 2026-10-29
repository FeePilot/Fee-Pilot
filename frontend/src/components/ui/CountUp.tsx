import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'motion/react';
import { useEffect } from 'react';
import { ease } from '@/lib/motion';

/**
 * A number that glides to its new value. The first render shows the final value (so prerendered
 * HTML and reduced-motion users see the real number); later changes animate.
 */
export function CountUp({
  value,
  format = (n) => n.toFixed(1),
  className,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(value);
  const text = useTransform(mv, (n) => format(n));

  useEffect(() => {
    if (reduce) {
      mv.set(value);
      return;
    }
    const controls = animate(mv, value, { duration: 0.9, ease: ease.out });
    return () => controls.stop();
  }, [value, reduce, mv]);

  return <motion.span className={className}>{text}</motion.span>;
}
