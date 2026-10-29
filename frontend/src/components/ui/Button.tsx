import { motion, type HTMLMotionProps } from 'motion/react';
import { forwardRef } from 'react';
import { cn } from '@/lib/cn';
import { spring } from '@/lib/motion';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const base =
  'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium transition-colors disabled:pointer-events-none disabled:opacity-50';

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-gradient-to-b from-accent-soft to-accent text-accent-ink shadow-[0_1px_0_rgb(255_255_255/0.35)_inset,0_8px_24px_-8px_var(--accent)] hover:shadow-glow',
  secondary:
    'border border-line-strong bg-surface text-fg backdrop-blur hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
  danger: 'border border-bad/40 bg-bad-bg text-bad hover:border-bad',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-9 px-3.5 text-sm',
  md: 'h-11 px-5 text-sm',
  lg: 'h-13 px-7 text-base',
};

/** Class names for anything that should look like a button, e.g. a router `<Link>`. */
export function buttonStyles(
  opts: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {},
) {
  const { variant = 'primary', size = 'md', className } = opts;
  return cn(base, variants[variant], sizes[size], className);
}

export type ButtonProps = Omit<HTMLMotionProps<'button'>, 'children'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks clicks while work is in flight. */
  loading?: boolean;
  children?: React.ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      disabled,
      className,
      children,
      type = 'button',
      ...rest
    },
    ref,
  ) {
    return (
      <motion.button
        ref={ref}
        type={type}
        disabled={disabled === true || loading}
        aria-busy={loading || undefined}
        whileHover={{ y: -1 }}
        whileTap={{ scale: 0.97 }}
        transition={spring.press}
        className={buttonStyles({ variant, size, className })}
        {...rest}
      >
        {loading ? <Spinner /> : null}
        {children}
      </motion.button>
    );
  },
);

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
    />
  );
}
