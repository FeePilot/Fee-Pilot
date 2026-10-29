import { motion } from 'motion/react';
import { Link } from 'react-router';
import { Backdrop } from '@/components/background/Backdrop';
import { ExampleCard } from '@/components/marketing/ExampleCard';
import { FaqAccordion } from '@/components/marketing/FaqAccordion';
import { Reveal, RevealGroup, RevealItem } from '@/components/marketing/Reveal';
import { Section } from '@/components/marketing/Section';
import { FAQ } from '@/components/marketing/content';
import { buttonStyles } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  ArrowRightIcon,
  ClockIcon,
  KeyOffIcon,
  ShieldIcon,
  WifiOffIcon,
  AlertIcon,
  CheckIcon,
} from '@/components/ui/icons';
import { Pill } from '@/components/ui/Pill';
import { duration, ease, fadeUp, stagger } from '@/lib/motion';
import { pageFor } from '@/seo/pages';
import { Seo } from '@/seo/Seo';
import { faqLd, softwareApplicationLd } from '@/seo/jsonld';

const STEPS = [
  {
    title: 'Give it a txid',
    body: 'Add an urgency and, if you like, a maximum budget. A txid is enough to look at a transaction.',
  },
  {
    title: 'FeePilot analyzes',
    body: 'It reads the transaction, its fee rate, mempool ancestors and descendants, and current fee estimates.',
  },
  {
    title: 'Compare the routes',
    body: 'RBF, CPFP and Wait are checked for eligibility and ranked, with costs, risks and unknowns shown.',
  },
  {
    title: 'You sign, then it tracks',
    body: 'FeePilot builds an unsigned PSBT. You sign it in your own wallet; it verifies and broadcasts, then follows the outcome.',
  },
];

const ROUTES = [
  {
    name: 'RBF',
    full: 'Replace by fee',
    use: 'You sent the transaction and want to re-send it with a higher fee.',
    needs:
      'Signing authority over the original inputs, and a replacement that satisfies the replacement fee rules.',
    tone: 'accent' as const,
  },
  {
    name: 'CPFP',
    full: 'Child pays for parent',
    use: 'You control an output of the stuck transaction, for example as the recipient.',
    needs:
      'Signing authority over that output, and a child fee large enough to make the package competitive.',
    tone: 'info' as const,
  },
  {
    name: 'Wait',
    full: 'Do nothing, for now',
    use: 'Nothing is feasible, or the extra fee is not worth it.',
    needs: 'Nothing. FeePilot explains why waiting is the recommendation.',
    tone: 'neutral' as const,
  },
];

const PRINCIPLES = [
  {
    icon: KeyOffIcon,
    title: 'No keys on the backend',
    body: 'Candidates are unsigned PSBTs. Signing happens in your wallet or signer.',
  },
  {
    icon: ShieldIcon,
    title: 'No broadcast without approval',
    body: 'Nothing is signed, spent or broadcast until you explicitly approve it.',
  },
  {
    icon: AlertIcon,
    title: 'Unknown stays unknown',
    body: 'A fact FeePilot cannot establish is reported as unknown, never assumed eligible.',
  },
  {
    icon: WifiOffIcon,
    title: '"Not seen" is not "absent"',
    body: 'A transaction missing from one node may exist elsewhere, so FeePilot says "not seen by this node".',
  },
];

export default function Landing() {
  return (
    <>
      <Seo {...pageFor('/')} jsonLd={[softwareApplicationLd(), faqLd(FAQ)]} />

      <div className="relative isolate overflow-hidden">
        <Backdrop />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-14 pb-20 sm:px-6 sm:pt-20 lg:grid-cols-[1.15fr_1fr] lg:gap-8 lg:pt-28 lg:pb-28">
          <motion.div variants={stagger(0.09)} initial="hidden" animate="show">
            <motion.div variants={fadeUp}>
              <Pill tone="accent">
                Offline fee awareness and recovery for Bitcoin
              </Pill>
            </motion.div>
            <motion.h1
              variants={fadeUp}
              className="mt-6 text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl"
            >
              Unstick a Bitcoin transaction,{' '}
              <span className="text-accent">
                without handing over your keys.
              </span>
            </motion.h1>
            <motion.p
              variants={fadeUp}
              className="mt-6 max-w-xl text-lg leading-relaxed text-pretty text-muted"
            >
              Paste a txid. FeePilot compares replacing it, boosting it or
              waiting, shows what each costs and risks, and prepares an unsigned
              transaction for you to sign. When you are offline it keeps showing
              the last fee snapshot, labelled with its age.
            </motion.p>
            <motion.div variants={fadeUp} className="mt-8 flex flex-wrap gap-3">
              <Link to="/app" className={buttonStyles({ size: 'lg' })}>
                Open the app <ArrowRightIcon aria-hidden="true" />
              </Link>
              <Link
                to="/how-it-works"
                className={buttonStyles({ variant: 'secondary', size: 'lg' })}
              >
                See how it works
              </Link>
            </motion.div>
            <motion.p variants={fadeUp} className="mt-5 text-sm text-muted">
              Early build. Fee estimates are probabilistic and confirmation is
              never guaranteed.
            </motion.p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{
              duration: duration.slow,
              ease: ease.out,
              delay: 0.25,
            }}
            className="flex justify-center lg:justify-end"
          >
            <ExampleCard />
          </motion.div>
        </div>
      </div>

      <Section
        id="how"
        eyebrow="How it works"
        title="From a stuck transaction to a signed fix in four steps"
        lead="Every step shows its evidence. If something cannot be known, it says so."
      >
        <RevealGroup className="relative grid gap-5 md:grid-cols-4" gap={0.12}>
          <motion.div
            aria-hidden="true"
            data-reveal
            initial={{ scaleX: 0 }}
            whileInView={{ scaleX: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 1.1, ease: ease.out }}
            style={{ transformOrigin: 'left' }}
            className="absolute top-5 right-[12%] left-[12%] hidden h-px bg-gradient-to-r from-accent/0 via-accent to-accent/0 md:block"
          />
          <ol className="contents">
            {STEPS.map((s, i) => (
              <li key={s.title} className="contents">
                <RevealItem className="relative">
                  <div className="relative z-10 mx-auto grid size-10 place-items-center rounded-full border border-accent/50 bg-solid font-mono text-sm font-semibold text-accent md:mx-0">
                    {i + 1}
                  </div>
                  <h3 className="mt-4 text-base font-semibold">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    {s.body}
                  </p>
                </RevealItem>
              </li>
            ))}
          </ol>
        </RevealGroup>
      </Section>

      <Section
        id="routes"
        eyebrow="Three routes"
        title="Replace, boost or wait"
        lead="Which routes are open depends on what you can sign. FeePilot checks that first."
      >
        <RevealGroup className="grid gap-5 md:grid-cols-3">
          {ROUTES.map((r) => (
            <RevealItem key={r.name} className="h-full">
              <Card
                interactive
                className="h-full"
                tabIndex={0}
                role="group"
                aria-label={`${r.name}: ${r.full}`}
              >
                <Pill tone={r.tone}>{r.name}</Pill>
                <h3 className="mt-4 text-xl font-semibold">{r.full}</h3>
                <dl className="mt-4 space-y-4 text-sm leading-relaxed">
                  <div>
                    <dt className="font-medium">Use when</dt>
                    <dd className="mt-1 text-muted">{r.use}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Needs</dt>
                    <dd className="mt-1 text-muted">{r.needs}</dd>
                  </div>
                </dl>
              </Card>
            </RevealItem>
          ))}
        </RevealGroup>
        <Reveal className="mt-6 text-center text-sm text-muted">
          Paid accelerators are not supported yet.{' '}
          <Link
            to="/how-it-works#compare"
            className="font-medium text-accent underline-offset-4 hover:underline"
          >
            Compare the routes in detail
          </Link>
        </Reveal>
      </Section>

      <Section
        id="offline"
        eyebrow="Offline continuity"
        title="Online, offline, reconnected"
        lead="Connectivity drops. FeePilot stays useful and stays honest about what it knows."
      >
        <RevealGroup className="grid gap-5 md:grid-cols-3">
          {[
            {
              icon: CheckIcon,
              tone: 'ok' as const,
              label: 'Online',
              body: 'Fee estimates are refreshed for several confirmation targets and saved as a timestamped snapshot with its network, units and source.',
            },
            {
              icon: ClockIcon,
              tone: 'warn' as const,
              label: 'Offline',
              body: 'The last snapshot is shown with its age and a freshness warning, never as a live fee. Total fee is estimated only when the size is known. Order notes stay Awaiting verification, and a note is not proof of payment.',
            },
            {
              icon: ArrowRightIcon,
              tone: 'info' as const,
              label: 'Reconnected',
              body: 'Estimates refresh, local notes sync without duplicates, and the transaction is checked before anything is recommended. Nothing is signed or broadcast without your approval.',
            },
          ].map(({ icon: Icon, tone, label, body }) => (
            <RevealItem key={label} className="h-full">
              <Card className="h-full">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-xl bg-surface-2 text-xl text-accent">
                    <Icon />
                  </span>
                  <Pill tone={tone}>{label}</Pill>
                </div>
                <p className="mt-4 text-sm leading-relaxed text-muted">
                  {body}
                </p>
              </Card>
            </RevealItem>
          ))}
        </RevealGroup>
      </Section>

      <Section
        id="safety"
        eyebrow="Safety principles"
        title="Built to say what it does not know"
        lead={
          <>
            The full list, including privacy and limits, is on the{' '}
            <Link
              to="/safety"
              className="font-medium text-accent underline-offset-4 hover:underline"
            >
              safety page
            </Link>
            .
          </>
        }
      >
        <RevealGroup className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {PRINCIPLES.map(({ icon: Icon, title, body }) => (
            <RevealItem key={title} className="h-full">
              <Card interactive className="h-full">
                <span className="grid size-10 place-items-center rounded-xl bg-accent/15 text-xl text-accent">
                  <Icon />
                </span>
                <h3 className="mt-4 text-base font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {body}
                </p>
              </Card>
            </RevealItem>
          ))}
        </RevealGroup>
      </Section>

      <Section
        id="faq"
        eyebrow="FAQ"
        title="Questions, answered plainly"
        className="max-w-3xl"
      >
        <Reveal>
          <FaqAccordion items={FAQ} />
        </Reveal>
      </Section>

      <section
        aria-labelledby="cta-title"
        className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 sm:pb-28"
      >
        <Reveal>
          <div className="relative isolate overflow-hidden rounded-[1.75rem] border border-line-strong bg-surface px-6 py-14 text-center shadow-glow backdrop-blur-xl sm:px-12">
            <Backdrop />
            <h2
              id="cta-title"
              className="mx-auto max-w-xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
            >
              Have a stuck transaction?
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-muted">
              Start with a txid. You stay in control of signing, and nothing is
              broadcast until you say so.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link to="/app" className={buttonStyles({ size: 'lg' })}>
                Open the app <ArrowRightIcon aria-hidden="true" />
              </Link>
              <Link
                to="/safety"
                className={buttonStyles({ variant: 'secondary', size: 'lg' })}
              >
                Read the safety page
              </Link>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  );
}
