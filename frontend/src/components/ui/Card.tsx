import { motion, type HTMLMotionProps } from 'motion/react';
import { cn } from '@/lib/cn';
import { spring } from '@/lib/motion';

export type CardProps = HTMLMotionProps<'div'> & {
  /** Lifts on hover; use for cards that are clickable or draw attention. */
  interactive?: boolean;
  /** An accent glow, for the one card that matters on a screen. */
  glow?: boolean;
};

/** A frosted-glass surface. Text on it stays readable over any background. */
export function Card({
  interactive = false,
  glow = false,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <motion.div
      whileHover={interactive ? { y: -3 } : undefined}
      transition={spring.soft}
      className={cn(
        'rounded-card border border-line bg-surface p-6 shadow-card backdrop-blur-xl',
        interactive && 'cursor-pointer hover:border-line-strong',
        glow && 'shadow-glow',
        className,
      )}
      {...rest}
    >
      {children}
    </motion.div>
  );
}
