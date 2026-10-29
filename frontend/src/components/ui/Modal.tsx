import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { duration, scaleIn } from '@/lib/motion';
import { CloseIcon } from './icons';

/**
 * An accessible modal (focus trap, Escape to close, labelled) that animates in and out.
 * Radix handles the behaviour; this component only adds the look and the motion.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/55 backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: duration.fast } }}
              />
            </Dialog.Overlay>
            <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
              <Dialog.Content asChild forceMount>
                <motion.div
                  variants={scaleIn}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  className={cn(
                    'pointer-events-auto max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-card border border-line-strong bg-solid p-6 shadow-card',
                    className,
                  )}
                >
                  <div className="flex items-start justify-between gap-4">
                    <Dialog.Title className="text-lg font-semibold tracking-tight text-fg">
                      {title}
                    </Dialog.Title>
                    <Dialog.Close
                      aria-label="Close"
                      className="-mt-1 -mr-1 grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                    >
                      <CloseIcon />
                    </Dialog.Close>
                  </div>
                  {description ? (
                    <Dialog.Description className="mt-1.5 text-sm text-muted">
                      {description}
                    </Dialog.Description>
                  ) : (
                    <Dialog.Description className="sr-only">
                      {title}
                    </Dialog.Description>
                  )}
                  {children ? <div className="mt-5">{children}</div> : null}
                  {footer ? (
                    <div className="mt-6 flex flex-wrap justify-end gap-3">
                      {footer}
                    </div>
                  ) : null}
                </motion.div>
              </Dialog.Content>
            </div>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}
