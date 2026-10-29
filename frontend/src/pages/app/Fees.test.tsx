import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { feesFixture, snapshotFixture } from '@/api/fixtures';
import type { FeesView } from '@/api/hooks';
import { renderApp } from '@/features/shared/test-utils';
import Fees from './Fees';

const refresh = vi.fn(async () => {});
let view: FeesView;
vi.mock('@/api/hooks', () => ({ useFees: () => view }));

const nowSecs = () => Math.floor(Date.now() / 1000);
function make(over: Partial<FeesView>, fetchedAgo = 30, snap = {}): FeesView {
  const body = feesFixture({
    snapshot: snapshotFixture({ fetched_at: nowSecs() - fetchedAgo, ...snap }),
  });
  return {
    fees: { snapshot: body.snapshot!, policy: body.policy },
    clockOffsetSecs: 0,
    state: 'live',
    error: null,
    refresh,
    ...over,
  };
}

describe('Fees page', () => {
  beforeEach(() => refresh.mockClear());

  it('shows a live, recent snapshot with node-sourced advice', () => {
    view = make({});
    renderApp(<Fees />);
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getByText('12.5')).toBeInTheDocument();
    expect(screen.getAllByText('node').length).toBeGreaterThan(0);
    expect(screen.queryByText(/not live/i)).not.toBeInTheDocument();
  });

  it('never makes a saved copy look live when offline', () => {
    view = make({ state: 'offline' }, 5000);
    renderApp(<Fees />);
    expect(screen.getAllByText('Offline').length).toBeGreaterThan(0);
    expect(screen.getByText('Very stale')).toBeInTheDocument();
    expect(screen.getByText('Saved copy, not live')).toBeInTheDocument();
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
  });

  it('explains a degraded API plainly', () => {
    view = make({ state: 'degraded', error: 'node unreachable' }, 900);
    renderApp(<Fees />);
    expect(screen.getByText('Past the freshness window')).toBeInTheDocument();
    expect(
      screen.getByText(/serving its last saved snapshot/),
    ).toBeInTheDocument();
  });

  it('labels third-party and approximate estimates', async () => {
    view = make({}, 30, {
      source: 'esplora',
      estimates: [
        { blocks: 6, sat_per_vb: 9, source: 'third_party', approximate: true },
        {
          blocks: 2,
          sat_per_vb: 14,
          source: 'third_party',
          approximate: false,
        },
        {
          blocks: 144,
          sat_per_vb: null,
          source: 'unavailable',
          approximate: false,
        },
      ],
    });
    renderApp(<Fees />);
    expect(
      screen.getAllByText('third party (approximate)').length,
    ).toBeGreaterThan(0);
    await userEvent.setup().click(screen.getByText('All cached estimates'));
    expect(screen.getAllByText('third party').length).toBeGreaterThan(0);
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('computes a total when the size is entered, and rejects a bad size', async () => {
    view = make({});
    renderApp(<Fees />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Transaction size (vB)'), '200');
    expect(await screen.findByText('2,500')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Transaction size (vB)'));
    await user.type(screen.getByLabelText('Transaction size (vB)'), 'abc');
    expect(
      await screen.findByText(/whole number of vbytes/),
    ).toBeInTheDocument();
  });

  it('says so when there is no snapshot', () => {
    view = {
      fees: null,
      clockOffsetSecs: 0,
      state: 'offline',
      error: null,
      refresh,
    };
    renderApp(<Fees />);
    expect(screen.getAllByText('No snapshot').length).toBeGreaterThan(0);
    expect(screen.getByText(/No fee snapshot is stored/)).toBeInTheDocument();
  });

  it('refreshes on request', async () => {
    view = make({});
    renderApp(<Fees />);
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /refresh snapshot/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
