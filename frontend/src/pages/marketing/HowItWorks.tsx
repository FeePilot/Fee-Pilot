import { Link } from 'react-router';
import { Backdrop } from '@/components/background/Backdrop';
import { Reveal, RevealGroup, RevealItem } from '@/components/marketing/Reveal';
import { Section } from '@/components/marketing/Section';
import { buttonStyles } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { pageFor } from '@/seo/pages';
import { Seo } from '@/seo/Seo';

const RECOVERY = [
  ['Submit', 'Enter a txid, and optionally an urgency and a maximum budget.'],
  [
    'Analyze',
    'FeePilot fetches the transaction, its fee rate, mempool ancestors and descendants, and current fee estimates.',
  ],
  [
    'Check eligibility',
    'Is RBF possible? Is there a spendable output for CPFP? Anything it cannot establish is reported as unknown.',
  ],
  [
    'Compare',
    'Each route shows its network fee, requirements, risks and unknowns. Waiting is always an option.',
  ],
  [
    'Authorize',
    'FeePilot builds an unsigned PSBT. You sign it in your own wallet. Nothing moves until you approve.',
  ],
  [
    'Submit and monitor',
    'The signed PSBT is verified against the one issued, then broadcast. FeePilot tracks pending, replaced and confirmed, and does not treat one confirmation as final.',
  ],
] as const;

const OFFLINE = [
  [
    'Online',
    'Estimates for several confirmation targets are saved as a timestamped snapshot: network, units, relay and mempool minimums, and source.',
  ],
  [
    'Offline',
    'The last snapshot is shown with its age and a freshness warning. You pick a cached estimate for your urgency. A total fee is shown only when the transaction size is known (rate times virtual size). Order notes can be kept locally and stay Awaiting verification.',
  ],
  [
    'Reconnected',
    'Estimates refresh, notes sync without creating duplicates, and the transaction is inspected before FeePilot warns, waits, or proposes RBF or CPFP.',
  ],
] as const;

const COMPARE = [
  {
    route: 'RBF',
    needs:
      'Signing authority over the original inputs; a valid higher-fee replacement.',
    costs: 'Extra network fee, enough to satisfy the replacement fee rules.',
    risks:
      'The original may confirm first, or be replaced by someone else; the job then becomes obsolete.',
  },
  {
    route: 'CPFP',
    needs: 'Signing authority over an output of the stuck transaction.',
    costs:
      'A child fee large enough to lift the whole package to the target rate.',
    risks:
      'Pays for the parent through the child; policy differences between nodes can matter.',
  },
  {
    route: 'Wait',
    needs: 'Nothing.',
    costs: 'No extra fee.',
    risks:
      'It may take a long time, and estimates can change. FeePilot explains why it suggests waiting.',
  },
] as const;

const LIMITS = [
  'A txid is enough to inspect a transaction, not to authorize RBF or CPFP.',
  'Fee estimates are probabilistic and time-sensitive. Cached estimates cannot show the live fee market while you are disconnected.',
  'Offline means offline-first records and cached information. It is not trustless offline settlement.',
  'Different nodes and miners apply different policies, and confirmation is never guaranteed.',
  'Regtest is repeatable but does not reproduce real fee-market pressure. The first version supports a narrow, well-tested set of scenarios.',
  'Paid accelerators are not supported yet.',
];

function Flow({
  items,
  label,
}: {
  items: readonly (readonly [string, string])[];
  label: string;
}) {
  return (
    <RevealGroup
      className="relative space-y-4 border-l border-line-strong pl-6 sm:pl-8"
      gap={0.08}
      aria-label={label}
    >
      <ol className="space-y-4">
        {items.map(([t, b], i) => (
          <li key={t}>
            <RevealItem className="relative">
              <span
                aria-hidden="true"
                className="absolute top-5 -left-[2.35rem] grid size-6 place-items-center rounded-full border border-accent/60 bg-solid font-mono text-xs text-accent sm:-left-[2.85rem]"
              >
                {i + 1}
              </span>
              <Card className="p-5">
                <h3 className="font-semibold">{t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{b}</p>
              </Card>
            </RevealItem>
          </li>
        ))}
      </ol>
    </RevealGroup>
  );
}

export default function HowItWorks() {
  return (
    <>
      <Seo {...pageFor('/how-it-works')} />
      <div className="relative isolate overflow-hidden">
        <Backdrop />
        <Section
          headingLevel={1}
          eyebrow="How it works"
          title="From a txid to a signed fix, and what happens offline"
          lead="Two flows share one rule: show the evidence, say what is unknown, and let you decide."
          className="pb-8 sm:pb-12"
        />
      </div>

      <Section
        id="recovery"
        title="The recovery flow"
        className="pt-8 sm:pt-12"
      >
        <div className="mx-auto max-w-2xl">
          <Flow items={RECOVERY} label="Recovery steps" />
        </div>
      </Section>

      <Section id="offline" title="The offline flow" className="pt-8 sm:pt-12">
        <div className="mx-auto max-w-2xl">
          <Flow items={OFFLINE} label="Offline steps" />
          <Reveal className="mt-5 text-sm text-muted">
            A saved estimate, local order note, QR code or user-supplied txid is
            never proof of broadcast, receipt or confirmation.
          </Reveal>
        </div>
      </Section>

      <Section
        id="compare"
        title="RBF, CPFP or Wait"
        lead="What each route needs, what it costs and what can go wrong."
      >
        <Reveal>
          <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card backdrop-blur-xl">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <caption className="sr-only">
                Comparison of RBF, CPFP and Wait
              </caption>
              <thead>
                <tr className="border-b border-line text-muted">
                  <th scope="col" className="px-5 py-4 font-medium">
                    Route
                  </th>
                  <th scope="col" className="px-5 py-4 font-medium">
                    Needs
                  </th>
                  <th scope="col" className="px-5 py-4 font-medium">
                    Costs
                  </th>
                  <th scope="col" className="px-5 py-4 font-medium">
                    Risks
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((r) => (
                  <tr
                    key={r.route}
                    className="border-b border-line align-top last:border-0"
                  >
                    <th scope="row" className="px-5 py-4">
                      <Pill tone="accent">{r.route}</Pill>
                    </th>
                    <td className="px-5 py-4 leading-relaxed text-muted">
                      {r.needs}
                    </td>
                    <td className="px-5 py-4 leading-relaxed text-muted">
                      {r.costs}
                    </td>
                    <td className="px-5 py-4 leading-relaxed text-muted">
                      {r.risks}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
        <Reveal className="mt-4 text-sm text-muted">
          Network fees and any provider charges are always shown separately.
          Paid accelerators are not supported yet.
        </Reveal>
      </Section>

      <Section
        id="limits"
        title="Limitations"
        className="max-w-3xl pt-8 sm:pt-12"
      >
        <RevealGroup className="space-y-3" gap={0.06}>
          {LIMITS.map((l) => (
            <RevealItem key={l}>
              <Card className="p-4 text-sm leading-relaxed text-muted sm:px-6">
                {l}
              </Card>
            </RevealItem>
          ))}
        </RevealGroup>
        <Reveal className="mt-10 flex flex-wrap justify-center gap-3">
          <Link to="/app" className={buttonStyles({ size: 'lg' })}>
            Open the app
          </Link>
          <Link
            to="/safety"
            className={buttonStyles({ variant: 'secondary', size: 'lg' })}
          >
            Safety and privacy
          </Link>
        </Reveal>
      </Section>
    </>
  );
}
