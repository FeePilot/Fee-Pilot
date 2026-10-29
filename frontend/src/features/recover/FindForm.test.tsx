import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/features/shared/test-utils';
import { FindForm } from './FindForm';

const GOOD = 'ab'.repeat(32);

describe('FindForm', () => {
  it('blocks a bad txid and does not call onAnalyze', async () => {
    const onAnalyze = vi.fn().mockResolvedValue(null);
    renderApp(<FindForm onAnalyze={onAnalyze} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Transaction id'), 'not-a-txid');
    await user.click(screen.getByRole('button', { name: /analyze/i }));
    expect(
      await screen.findByText('A txid is 64 hexadecimal characters.'),
    ).toBeInTheDocument();
    expect(onAnalyze).not.toHaveBeenCalled();
  });

  it('submits normalised values for a good txid', async () => {
    const onAnalyze = vi.fn().mockResolvedValue(null);
    renderApp(
      <FindForm onAnalyze={onAnalyze} initialTxid={GOOD.toUpperCase()} />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /analyze/i }));
    await waitFor(() => expect(onAnalyze).toHaveBeenCalledTimes(1));
    expect(onAnalyze.mock.calls[0]?.[0]).toMatchObject({
      txid: GOOD,
      urgency: 'normal',
      budget: null,
      canSign: 'unknown',
      controls: 'unknown',
    });
  });

  it('shows the output value field only when you control an output', async () => {
    renderApp(<FindForm onAnalyze={vi.fn()} />);
    const user = userEvent.setup();
    expect(
      screen.queryByLabelText('Value of that output (sats)'),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('combobox', { name: /control an output/i }),
    );
    await user.click(
      await screen.findByRole('option', { name: /yes, i received it/i }),
    );
    expect(
      await screen.findByLabelText('Value of that output (sats)'),
    ).toBeInTheDocument();
  });

  it('shows the error returned by the API inline', async () => {
    const onAnalyze = vi
      .fn()
      .mockResolvedValue('The Bitcoin node is unreachable right now.');
    renderApp(<FindForm onAnalyze={onAnalyze} initialTxid={GOOD} />);
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /analyze/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unreachable');
  });
});
