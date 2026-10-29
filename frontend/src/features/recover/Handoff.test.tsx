import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/features/shared/test-utils';
import { Handoff } from './Handoff';

const mutateAsync = vi.fn();
vi.mock('@/api/hooks', () => ({
  useSubmitJob: () => ({ mutateAsync, isPending: false }),
}));

const summary = {
  jobId: '3f2b8c1e-5d7a-4c1b-9e0a-1a2b3c4d5e6f',
  route: 'rbf' as const,
  txid: 'f'.repeat(64),
  psbt: 'cHNidP8BAAoCAAAAAAAAAAAA',
  extraFeeSat: 1620,
};

describe('Handoff approval', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
  });

  it('will not open the approval modal without a signed PSBT', async () => {
    renderApp(<Handoff summary={summary} />);
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Approve and broadcast' }));
    expect(
      await screen.findByText('Paste the signed PSBT from your wallet.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('cannot confirm until the box is ticked, then submits exactly once', async () => {
    mutateAsync.mockResolvedValue({
      ok: true,
      status: 200,
      message: 'ok',
      body: {},
    });
    renderApp(<Handoff summary={summary} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Signed PSBT'), 'c2lnbmVkLXBzYnQ=');
    await user.click(
      screen.getByRole('button', { name: 'Approve and broadcast' }),
    );

    const dialog = await screen.findByRole('dialog');
    const confirm = screen.getByRole('button', {
      name: /confirm and broadcast/i,
    });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(mutateAsync).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('checkbox', {
        name: /I have reviewed the transaction and approve broadcasting it/i,
      }),
    );
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith('c2lnbmVkLXBzYnQ=');
    expect(dialog).toBeDefined();
  });

  it('keeps the modal open and shows the reason when the API refuses', async () => {
    mutateAsync.mockResolvedValue({
      ok: false,
      status: 422,
      message: 'signed PSBT differs from the unsigned one',
      code: 'unprocessable',
    });
    renderApp(<Handoff summary={summary} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Signed PSBT'), 'c2lnbmVkLXBzYnQ=');
    await user.click(
      screen.getByRole('button', { name: 'Approve and broadcast' }),
    );
    await user.click(await screen.findByRole('checkbox'));
    await user.click(
      screen.getByRole('button', { name: /confirm and broadcast/i }),
    );
    expect(
      (await screen.findAllByText(/differs from the unsigned one/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closing with Cancel never submits', async () => {
    renderApp(<Handoff summary={summary} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Signed PSBT'), 'c2lnbmVkLXBzYnQ=');
    await user.click(
      screen.getByRole('button', { name: 'Approve and broadcast' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
