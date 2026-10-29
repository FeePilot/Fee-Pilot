import { cn } from '@/lib/cn';
import { Reveal } from './Reveal';

export function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
  className,
  headingLevel = 2,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  lead?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  headingLevel?: 1 | 2;
}) {
  const H = headingLevel === 1 ? 'h1' : 'h2';
  const labelId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={labelId}
      className={cn(
        'mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24',
        className,
      )}
    >
      <Reveal className="mx-auto mb-10 max-w-2xl text-center sm:mb-14">
        {eyebrow ? (
          <p className="mb-3 text-xs font-semibold tracking-[0.18em] text-accent uppercase">
            {eyebrow}
          </p>
        ) : null}
        <H
          id={labelId}
          className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
        >
          {title}
        </H>
        {lead ? (
          <p className="mt-4 text-base leading-relaxed text-pretty text-muted sm:text-lg">
            {lead}
          </p>
        ) : null}
      </Reveal>
      {children}
    </section>
  );
}
