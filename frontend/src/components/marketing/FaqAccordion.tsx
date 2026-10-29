import * as Accordion from '@radix-ui/react-accordion';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { ChevronDownIcon } from '@/components/ui/icons';
import { duration, ease } from '@/lib/motion';
import type { Faq } from '@/seo/jsonld';

/**
 * Accordion built on Radix (Tab, Enter/Space, Arrow keys, Home/End). Answers are mounted only while
 * open; the same data is also emitted as FAQPage JSON-LD by the page.
 */
export function FaqAccordion({ items }: { items: Faq[] }) {
  const [open, setOpen] = useState<string>('');
  return (
    <Accordion.Root
      type="single"
      collapsible
      value={open}
      onValueChange={setOpen}
      className="space-y-3"
    >
      {items.map((item, i) => {
        const value = `faq-${i}`;
        const isOpen = open === value;
        return (
          <Accordion.Item
            key={value}
            value={value}
            className="overflow-hidden rounded-2xl border border-line bg-surface backdrop-blur-xl transition-colors data-[state=open]:border-line-strong"
          >
            <Accordion.Header className="m-0">
              <Accordion.Trigger className="group flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-base font-medium hover:text-accent sm:px-6">
                <span>{item.q}</span>
                <motion.span
                  aria-hidden="true"
                  animate={{ rotate: isOpen ? 180 : 0 }}
                  transition={{ duration: duration.base, ease: ease.out }}
                  className="text-lg text-muted"
                >
                  <ChevronDownIcon />
                </motion.span>
              </Accordion.Trigger>
            </Accordion.Header>
            <AnimatePresence initial={false}>
              {isOpen ? (
                <Accordion.Content forceMount asChild>
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: duration.base, ease: ease.out }}
                    className="overflow-hidden"
                  >
                    <p className="px-5 pb-5 leading-relaxed text-pretty text-muted sm:px-6">
                      {item.a}
                    </p>
                  </motion.div>
                </Accordion.Content>
              ) : null}
            </AnimatePresence>
          </Accordion.Item>
        );
      })}
    </Accordion.Root>
  );
}
