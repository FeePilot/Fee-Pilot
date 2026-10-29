import { render, screen } from '@testing-library/react';
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
vi.mock('@/api/hooks', () => ({
  useOnline: () => online,
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
});
