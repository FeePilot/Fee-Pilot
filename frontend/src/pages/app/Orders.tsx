import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { useOnline, useOrders } from '@/api/hooks';
import { Banner } from '@/features/shared/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Pill, type Tone } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { OrderForm, type OrderFormValues } from '@/features/orders/OrderForm';
import { formatSats, shortId } from '@/lib/format';
import { describeRecord, type LocalOrderState } from '@/lib/queue';
import { fadeUp, spring, stagger } from '@/lib/motion';
import { Seo } from '@/seo/Seo';

// Never green: no state here proves a payment happened.
const stateTone: Record<LocalOrderState, Tone> = {
  awaiting_verification: 'warn',
  seen: 'info',
  replaced: 'bad',
  not_seen: 'warn',
  conflict: 'bad',
};

export default function Orders() {
  const toast = useToast();
  const online = useOnline();
  const { orders, add, remove, sync, syncing, message, persistent } =
    useOrders();
  const [toDelete, setToDelete] = useState<string | null>(null);

  async function onSave(v: OrderFormValues): Promise<string | null> {
    const res = await add({ amountSat: v.amount, memo: v.memo, txid: v.txid });
    if (!res.ok) return res.error;
    toast({
      title: 'Note saved',
      description: 'Stored on this device. It is not proof of payment.',
      tone: 'ok',
    });
    return null;
  }

  async function confirmDelete() {
    if (!toDelete) return;
    await remove(toDelete);
    setToDelete(null);
    toast({ title: 'Note deleted', tone: 'info', durationMs: 2800 });
  }

  return (
    <div className="grid gap-6">
      <Seo
        title="Offline orders"
        description="Notes about payments, kept on this device."
        path="/app/orders"
        noindex
      />
      <header className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Offline orders
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted sm:text-base">
          Note a payment you plan to make or say you made, even with no
          connection. It stays on this device as &ldquo;awaiting
          verification&rdquo; until it can be checked.{' '}
          <b className="text-fg">A note is not proof of payment.</b>
        </p>
      </header>

      {!persistent ? (
        <Banner tone="warn" role="status">
          Browser storage is blocked, so notes are kept in memory and last only
          until you close this page.
        </Banner>
      ) : null}

      <Card className="p-5 sm:p-7">
        <h2 className="mb-5 text-lg font-semibold tracking-tight">New note</h2>
        <OrderForm onSave={onSave} />
      </Card>

      <Card className="p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">
            Your notes{' '}
            <span className="font-normal text-muted">({orders.length})</span>
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <span role="status" className="text-sm text-muted">
              {message}
            </span>
            <Button
              variant="secondary"
              size="sm"
              loading={syncing}
              disabled={!online}
              onClick={() => void sync()}
            >
              {online ? 'Sync now' : 'Sync (needs connection)'}
            </Button>
          </div>
        </div>
        {orders.length === 0 ? (
          <p className="mt-4 text-sm text-muted">No notes yet.</p>
        ) : (
          <motion.ul
            variants={stagger(0.05)}
            initial="hidden"
            animate="show"
            className="mt-4 grid gap-3"
          >
            <AnimatePresence initial={false}>
              {orders.map((r) => {
                const d = describeRecord(r);
                return (
                  <motion.li
                    key={r.id}
                    layout
                    variants={fadeUp}
                    exit={{
                      opacity: 0,
                      scale: 0.97,
                      transition: { duration: 0.18 },
                    }}
                    transition={spring.soft}
                    className="grid gap-2 rounded-xl border border-line bg-surface-2/50 p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="text-base tabular-nums">
                        {formatSats(r.amount_sat)} sats
                      </strong>
                      <Pill tone={stateTone[r.state]}>{d.state}</Pill>
                    </div>
                    {r.memo ? (
                      <p className="text-sm break-words">{r.memo}</p>
                    ) : null}
                    {r.txid ? (
                      <code
                        className="font-mono text-xs text-muted"
                        title={r.txid}
                      >
                        {shortId(r.txid)}
                      </code>
                    ) : null}
                    <p className="text-xs leading-relaxed text-muted">
                      {new Date(r.created_at * 1000).toLocaleString()} ·{' '}
                      {d.synced ? 'synced' : 'on this device only'}.{' '}
                      {r.server_note || d.note}
                    </p>
                    <div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setToDelete(r.id)}
                        aria-label={`Delete note for ${formatSats(r.amount_sat)} sats`}
                      >
                        Delete note
                      </Button>
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </motion.ul>
        )}
      </Card>

      <Modal
        open={toDelete !== null}
        onOpenChange={(o) => {
          if (!o) setToDelete(null);
        }}
        title="Delete this note?"
        description="It is removed from this device. If it was already synced, the server keeps its own copy."
        footer={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void confirmDelete()}>
              Delete note
            </Button>
          </>
        }
      />
    </div>
  );
}
