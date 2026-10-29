import type { Faq } from '@/seo/jsonld';

export const FAQ: Faq[] = [
  {
    q: 'Does FeePilot guarantee my transaction will confirm?',
    a: 'No. Fee estimates are probabilistic and time-sensitive, and miners decide what goes into a block. FeePilot compares the options and shows their costs and risks, but it never controls miners and never promises confirmation.',
  },
  {
    q: 'Does FeePilot hold my keys or sign for me?',
    a: 'No. The backend holds no private keys. For a recovery it builds an unsigned PSBT, you sign it in your own wallet or signer, and you hand the signed PSBT back. FeePilot refuses to broadcast a signed PSBT whose inputs, outputs, amounts or sequences differ from the one it issued, and nothing is broadcast without your explicit approval.',
  },
  {
    q: 'Can I recover a transaction with only its txid?',
    a: 'A txid is enough to inspect a transaction, but not to authorize a recovery. Replace-by-fee needs signing authority over the original inputs. Child-pays-for-parent needs signing authority over an output of the stuck transaction that you control. If neither applies, FeePilot says so and explains why waiting may be the sensible choice.',
  },
  {
    q: 'What is the difference between RBF and CPFP?',
    a: 'RBF replaces your stuck transaction with a higher-fee version, so you must have sent it and be able to sign its inputs. CPFP spends an output of the stuck transaction in a new child that pays enough fee to lift the pair, so you must control one of its outputs, for example as the recipient. Both cost extra network fee; FeePilot shows how much before you sign.',
  },
  {
    q: 'What happens when I am offline?',
    a: 'FeePilot shows the last fee snapshot it saved, labelled with its age and a freshness warning, and never presents it as a live fee. Total fee is estimated only when the transaction size is known (rate times virtual size). When you reconnect, estimates refresh and nothing is recommended or done before the transaction status is checked.',
  },
  {
    q: 'Is a local order note proof of payment?',
    a: 'No. A local order record, QR code or user-supplied txid is not proof of broadcast, receipt or confirmation. Records stay marked Awaiting verification until they are checked against a node, and syncing them again does not create duplicates.',
  },
  {
    q: 'If a transaction is not seen by my node, does it not exist?',
    a: 'No. A transaction missing from one node may exist elsewhere, for example in another mempool or already confirmed. FeePilot says it was not seen by this source and keeps the answer as unknown; it never says the transaction does not exist.',
  },
  {
    q: 'Does FeePilot support paid accelerators?',
    a: 'Not yet. Paid transaction accelerators are planned as an optional later feature. Today FeePilot compares RBF, CPFP and waiting only.',
  },
  {
    q: 'Which networks is it ready for?',
    a: 'The recovery flow has been exercised on regtest, and there is a guide for signet, but its signet check has not been run on a live signet yet. FeePilot is an early build: do not point it at mainnet funds. Snapshots and jobs carry their network, and mainnet, testnet and regtest data are never blended.',
  },
  {
    q: 'What does FeePilot store, and for how long?',
    a: 'It stores fee snapshots, order notes and recovery jobs. Logs carry job ids, not txids, memos, PSBTs or addresses. By default the tracker deletes fee history, order notes and finished jobs older than 30 days; an operator can change that. Public endpoints are rate limited.',
  },
];

export const NAV_LINKS = [
  { to: '/how-it-works', label: 'How it works' },
  { to: '/safety', label: 'Safety' },
] as const;
