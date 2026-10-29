import { Link } from 'react-router';
import { Backdrop } from '@/components/background/Backdrop';
import { Reveal, RevealGroup, RevealItem } from '@/components/marketing/Reveal';
import { Section } from '@/components/marketing/Section';
import { buttonStyles } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { pageFor } from '@/seo/pages';
import { Seo } from '@/seo/Seo';

const PRINCIPLES = [
  [
    'No private keys in the backend',
    'Recovery candidates are unsigned PSBTs. Signing happens in a wallet or signer you control.',
  ],
  [
    'No broadcast or payment without approval',
    'Nothing is broadcast until you have signed and explicitly approved it.',
  ],
  [
    'Evidence-based recommendations',
    'Unknown facts are reported as unknown and never assumed eligible.',
  ],
  [
    'Offline truthfulness',
    'Cached data is always labelled with its age and never shown as live. A saved estimate, local order, QR code or user-supplied txid is not proof of broadcast, receipt or confirmation.',
  ],
  [
    'Observation limits',
    'A transaction missing from one node may exist elsewhere. FeePilot says "not seen by this node", never "does not exist".',
  ],
  [
    'No network mix-ups',
    'Snapshots and jobs carry their network. Mainnet, testnet and regtest data are never blended.',
  ],
  [
    'Cost transparency',
    'Bitcoin network fees and any provider service charges are shown separately.',
  ],
  [
    'Reorg-aware',
    'One confirmation is not treated as final. A reorg returns a confirmed job to broadcast.',
  ],
] as const;

const CANNOT = [
  'Control miners or guarantee that a transaction confirms.',
  'Turn a cached fee estimate into a live one.',
  'Authorize a recovery from a txid alone; you need signing authority over the inputs or outputs involved.',
  'Broadcast while every device is offline, or prevent offline double-spends.',
  'Sign or spend automatically.',
  'Accelerate through a paid provider. That is not supported yet.',
];

export default function Safety() {
  return (
    <>
      <Seo {...pageFor('/safety')} />
      <div className="relative isolate overflow-hidden">
        <Backdrop />
        <Section
          headingLevel={1}
          eyebrow="Safety"
          title="Safe by design, and clear about its limits"
          lead="FeePilot is built so that the worst thing a mistake can cost you is a recommendation you did not take."
          className="pb-8 sm:pb-12"
        />
      </div>

      <Section id="principles" title="Principles" className="pt-8 sm:pt-12">
        <RevealGroup className="grid gap-5 md:grid-cols-2">
          {PRINCIPLES.map(([t, b]) => (
            <RevealItem key={t} className="h-full">
              <Card interactive className="h-full">
                <h3 className="font-semibold">{t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{b}</p>
              </Card>
            </RevealItem>
          ))}
        </RevealGroup>
      </Section>

      <Section
        id="cannot"
        title="What FeePilot cannot do"
        className="max-w-3xl pt-8 sm:pt-12"
      >
        <RevealGroup className="space-y-3" gap={0.06}>
          {CANNOT.map((c) => (
            <RevealItem key={c}>
              <Card className="p-4 text-sm leading-relaxed sm:px-6">{c}</Card>
            </RevealItem>
          ))}
        </RevealGroup>
      </Section>

      <Section
        id="signing"
        title="The signing boundary"
        lead="Your keys never cross it."
        className="max-w-3xl pt-8 sm:pt-12"
      >
        <Reveal>
          <Card className="space-y-4 text-sm leading-relaxed text-muted">
            <p>
              <strong className="text-fg">Out:</strong> FeePilot builds an
              unsigned PSBT for the route you chose and shows its fee and the
              extra fee it adds.
            </p>
            <p>
              <strong className="text-fg">In your wallet:</strong> you review
              and sign it with your own wallet or signer. FeePilot never sees a
              key.
            </p>
            <p>
              <strong className="text-fg">In:</strong> you return the signed
              PSBT. FeePilot verifies that its inputs, outputs, amounts and
              sequences match what it issued and refuses to broadcast it if they
              differ. Only then, after your explicit approval, is it broadcast,
              once.
            </p>
          </Card>
        </Reveal>
      </Section>

      <Section id="privacy" title="Privacy" className="max-w-3xl pt-8 sm:pt-12">
        <Reveal>
          <Card className="space-y-4 text-sm leading-relaxed text-muted">
            <p>
              FeePilot stores minimal identifiers: fee snapshots, order notes
              and recovery jobs. Logs carry job ids, not txids, order keys,
              memos, PSBTs or addresses. One exception exists: if a broadcast
              succeeded but could not be recorded, the error log includes the
              txid so it can be recovered.
            </p>
            <p>
              By default the tracker deletes fee history, order notes and
              finished jobs older than 30 days; an operator can change or
              disable this. Unfinished jobs and the newest good snapshot per
              network are kept. Public endpoints are rate limited.
            </p>
          </Card>
        </Reveal>
      </Section>

      <Section
        id="limits"
        title="Limitations"
        className="max-w-3xl pt-8 sm:pt-12"
      >
        <Reveal>
          <Card className="space-y-4 text-sm leading-relaxed text-muted">
            <p>
              Fee estimates are probabilistic and time-sensitive. Different
              nodes and miners apply different policies. FeePilot is an early
              build tested on regtest; its signet check has not been run on a
              live signet yet, so do not point it at mainnet funds you cannot
              afford to lose.
            </p>
          </Card>
        </Reveal>
        <Reveal className="mt-10 flex flex-wrap justify-center gap-3">
          <Link to="/app" className={buttonStyles({ size: 'lg' })}>
            Open the app
          </Link>
          <Link
            to="/how-it-works"
            className={buttonStyles({ variant: 'secondary', size: 'lg' })}
          >
            How it works
          </Link>
        </Reveal>
      </Section>
    </>
  );
}
