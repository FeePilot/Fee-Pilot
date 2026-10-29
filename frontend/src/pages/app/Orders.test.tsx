import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/features/shared/test-utils';
import type { OrderInput, OrderRecord } from '@/lib/queue';
import Orders from './Orders';

const syncFn = vi.fn();
let persistent = true;

// A tiny in-memory stand-in for the real hook, so add and remove really change the list.
vi.mock('@/api/hooks', () => ({
  useOnline: () => true,
  useOrders: () => {
    const [orders, setOrders] = useState<OrderRecord[]>([]);
    return {
      orders,
      persistent,
      syncing: false,
      message: '',
      sync: syncFn,
      add: async (input: OrderInput) => {
        setOrders((cur) => [
          ...cur,
          {
            id: String(cur.length + 1),
            created_at: 1_700_000_000,
            amount_sat: Number(input.amountSat),
            memo: input.memo ?? '',
            txid: input.txid || null,
            state: 'awaiting_verification',
            sync_state: 'local',
            idempotency_key: `k${cur.length}`,
            schema_version: 1,
          },
        ]);
        return { ok: true as const };
      },
      remove: async (id: string) =>
        setOrders((cur) => cur.filter((o) => o.id !== id)),
    };
  },
}));

describe('Orders page', () => {
  beforeEach(() => {
    persistent = true;
    syncFn.mockReset();
  });

  it('validates the form', async () => {
    renderApp(<Orders />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    expect(
      await screen.findByText(/whole number of sats, above zero/),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Amount (sats)'), '1500');
    await user.type(screen.getByLabelText('Txid (optional)'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    expect(
      await screen.findByText('A txid is 64 hexadecimal characters.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No notes yet.')).toBeInTheDocument();
  });

  it('adds a note with honest wording, then deletes it after confirming', async () => {
    renderApp(<Orders />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Amount (sats)'), '21000');
    await user.type(screen.getByLabelText('Memo (optional)'), 'coffee');
    await user.click(screen.getByRole('button', { name: 'Save note' }));

    const item = await screen.findByRole('listitem');
    expect(within(item).getByText('21,000 sats')).toBeInTheDocument();
    expect(within(item).getByText('Awaiting verification')).toBeInTheDocument();
    expect(within(item).getByText(/Not proof of payment/)).toBeInTheDocument();

    await user.click(
      within(item).getByRole('button', { name: /delete note/i }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete note' }),
    );
    await waitFor(() =>
      expect(screen.getByText('No notes yet.')).toBeInTheDocument(),
    );
  });

  it('syncs on request and warns when storage is not persistent', async () => {
    persistent = false;
    renderApp(<Orders />);
    expect(screen.getByText(/Browser storage is blocked/)).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Sync now' }));
    expect(syncFn).toHaveBeenCalledTimes(1);
  });
});
