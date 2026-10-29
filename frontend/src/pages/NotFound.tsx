import { motion } from 'motion/react';
import { Link } from 'react-router';
import { Backdrop } from '@/components/background/Backdrop';
import { buttonStyles } from '@/components/ui/Button';
import { duration, ease, fadeUp, stagger } from '@/lib/motion';
import { Seo } from '@/seo/Seo';

export default function NotFound() {
  return (
    <main
      id="main"
      className="relative isolate grid min-h-dvh place-items-center overflow-hidden px-4 py-20"
    >
      <Seo
        noindex
        path="/404"
        title="Page not found"
        description="This page does not exist on FeePilot."
      />
      <Backdrop />
      <motion.div
        variants={stagger(0.1)}
        initial="hidden"
        animate="show"
        className="text-center"
      >
        <motion.p
          variants={fadeUp}
          aria-hidden="true"
          className="bg-gradient-to-b from-accent-soft to-accent bg-clip-text font-mono text-8xl font-bold tracking-tighter text-transparent sm:text-9xl"
        >
          404
        </motion.p>
        <motion.h1
          variants={fadeUp}
          className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl"
        >
          This page was not found
        </motion.h1>
        <motion.p
          variants={fadeUp}
          className="mx-auto mt-4 max-w-md text-muted"
        >
          The link may be old or mistyped. Head back home or open the app.
        </motion.p>
        <motion.div
          variants={fadeUp}
          transition={{ duration: duration.base, ease: ease.out }}
          className="mt-8 flex flex-wrap justify-center gap-3"
        >
          <Link to="/" className={buttonStyles({ size: 'lg' })}>
            Back to home
          </Link>
          <Link
            to="/app"
            className={buttonStyles({ variant: 'secondary', size: 'lg' })}
          >
            Open the app
          </Link>
        </motion.div>
      </motion.div>
    </main>
  );
}
