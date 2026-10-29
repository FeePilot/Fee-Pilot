import { cn } from '@/lib/cn';

/**
 * The page background: a layered CSS gradient that always renders (and is what the prerendered
 * HTML shows). It is the fallback and the base for an optional WebGL layer on top.
 * `fixed` pins it to the viewport; otherwise it fills its positioned parent.
 */
export function Backdrop({
  fixed = false,
  className,
}: {
  fixed?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none inset-0 -z-10 overflow-hidden',
        fixed ? 'fixed' : 'absolute',
        className,
      )}
    >
      <div className="absolute -top-1/3 left-1/2 h-[70vmax] w-[70vmax] -translate-x-1/2 rounded-full bg-accent/10 blur-3xl" />
      <div className="absolute -right-1/4 -bottom-1/3 h-[50vmax] w-[50vmax] rounded-full bg-info/10 blur-3xl" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,transparent_0%,var(--bg)_75%)]" />
    </div>
  );
}
