import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionConfig } from 'motion/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { feesFixture, snapshotFixture } from '@/api/fixtures';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { stubDom } from '@/features/shared/test-utils';
import AppLayout from './AppLayout';

let online = true;
let network: 'regtest' | 'mainnet' = 'regtest';
let offered: ('regtest' | 'signet')[] = ['regtest'];
vi.mock('@/api/hooks', () => ({
  useOnline: () => online,
  useNetworks: () => ({
    data: {
      ok: true,
      status: 200,
      message: 'ok',
      body: { default: 'regtest', networks: offered },
    },
  }),
  useFees: () => ({
    fees: {
      snapshot: feesFixture({ snapshot: snapshotFixture({ network }) })
        .snapshot,
      policy: { recent_secs: 600, stale_secs: 3600 },
    },
    clockOffsetSecs: 0,
    state: 'live',
    error: null,
    refresh: async () => {},
  }),
}));

function renderLayout() {
  stubDom();
  return render(
    <HelmetProvider>
      <MotionConfig reducedMotion="always">
        <ThemeProvider>
          <MemoryRouter initialEntries={['/app/fees']}>
            <Routes>
              <Route path="app" element={<AppLayout />}>
                <Route index element={<p>recover page</p>} />
                <Route path="fees" element={<p>fees page</p>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </MotionConfig>
    </HelmetProvider>,
  );
}

describe('AppLayout', () => {
  beforeEach(() => {
    online = true;
    network = 'regtest';
    offered = ['regtest'];
    localStorage.clear();
  });

  it('renders navigation, the network pill and the page', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: 'Recover' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fees' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Orders' })).toBeInTheDocument();
    expect(screen.getByText('regtest')).toBeInTheDocument();
    expect(screen.getByText('fees page')).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(screen.queryByText(/Offline mode/)).not.toBeInTheDocument();
  });

  it('shows the offline banner when the API is unreachable', () => {
    online = false;
    renderLayout();
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent(/offline mode/i);
    expect(banner).toHaveTextContent(/nothing can be broadcast/i);
    expect(banner).toHaveTextContent(/nothing here confirms/i);
  });

  it('warns on mainnet', () => {
    network = 'mainnet';
    renderLayout();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /early build: test on regtest or signet first/i,
    );
  });
  it('shows a plain network pill when the server offers one network', () => {
    renderLayout();
    expect(screen.queryByRole('group', { name: 'Network' })).toBeNull();
    expect(screen.getByText('regtest')).toBeInTheDocument();
  });

  it('offers a switch when the server has several networks', async () => {
    offered = ['regtest', 'signet'];
    renderLayout();
    const group = screen.getByRole('group', { name: 'Network' });
    expect(
      within(group).getByRole('button', { name: 'regtest' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(group).getByRole('button', { name: 'signet' }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('remembers the chosen network and clears the choice for the default', async () => {
    offered = ['regtest', 'signet'];
    renderLayout();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'signet' }));
    expect(localStorage.getItem('feepilot.network.v1')).toBe('signet');
    await user.click(screen.getByRole('button', { name: 'regtest' }));
    expect(localStorage.getItem('feepilot.network.v1')).toBeNull();
  });
});
