import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { recommendationFixture } from '@/api/fixtures';
import { renderApp } from '@/features/shared/test-utils';
import { Compare } from './Compare';

describe('Compare', () => {
  it('shows each route with its eligibility and the recommendation', () => {
    renderApp(
      <Compare
        rec={recommendationFixture()}
        onBuild={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    const rbf = screen.getByRole('article', { name: /replace-by-fee/i });
    expect(within(rbf).getByText('Recommended')).toBeInTheDocument();
    expect(within(rbf).getByText('Feasible')).toBeInTheDocument();
    expect(within(rbf).getByText('Extra network fee')).toBeInTheDocument();
    expect(within(rbf).getByText('Service charge')).toBeInTheDocument();

    const cpfp = screen.getByRole('article', {
      name: /child-pays-for-parent/i,
    });
    expect(within(cpfp).getByText('Unknown')).toBeInTheDocument();
    expect(
      within(cpfp).getByText(/Missing: whether you control an output/),
    ).toBeInTheDocument();
    expect(
      within(cpfp).queryByRole('button', { name: /build/i }),
    ).not.toBeInTheDocument();

    const ext = screen.getByRole('article', { name: /external accelerator/i });
    expect(
      within(ext).getAllByText('Not supported yet').length,
    ).toBeGreaterThan(0);
    expect(
      within(ext).getByRole('button', { name: /not supported yet/i }),
    ).toBeDisabled();
  });

  it('builds the chosen route', async () => {
    const onBuild = vi.fn();
    renderApp(
      <Compare
        rec={recommendationFixture()}
        onBuild={onBuild}
        onBack={vi.fn()}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /build this recovery/i }));
    expect(onBuild).toHaveBeenCalledWith('rbf');
  });

  it('says so when the transaction is already confirmed', () => {
    const rec = recommendationFixture();
    rec.analysis.status = 'confirmed';
    rec.analysis.confirmations = 3;
    renderApp(<Compare rec={rec} onBuild={vi.fn()} onBack={vi.fn()} />);
    expect(
      screen.getByText(/Already confirmed with 3 confirmations/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /build this recovery/i }),
    ).not.toBeInTheDocument();
  });
});
