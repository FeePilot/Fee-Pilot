import { cn } from '@/lib/cn';

/** A loading placeholder that shimmers (and stands still for reduced motion). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'rounded-lg bg-surface-2 motion-safe:animate-pulse',
        className,
      )}
    />
  );
}
