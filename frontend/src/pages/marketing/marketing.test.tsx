import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppProviders } from '@/app/providers';
import MarketingLayout from '@/components/layout/MarketingLayout';
import NotFound from '@/pages/NotFound';
import HowItWorks from './HowItWorks';
import Landing from './Landing';
import Safety from './Safety';

// jsdom has no IntersectionObserver (motion's whileInView needs one). This one reports "visible".
beforeAll(() => {
  class IO {
    constructor(private cb: IntersectionObserverCallback) {}
    observe(el: Element) {
      this.cb(
        [
          {
            isIntersecting: true,
            target: el,
            intersectionRatio: 1,
          } as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      );
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = IO;
});

function renderAt(path: string) {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<MarketingLayout />}>
            <Route index element={<Landing />} />
            <Route path="how-it-works" element={<HowItWorks />} />
            <Route path="safety" element={<Safety />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('marketing pages', () => {
  it.each([
    ['/', /unstick a bitcoin transaction/i],
    ['/how-it-works', /from a txid to a signed fix/i],
    ['/safety', /safe by design/i],
    ['/nope', /page was not found/i],
  ])('%s renders exactly one h1', (path, name) => {
    renderAt(path);
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(name);
  });

  it('layout has landmarks, skip link, nav links and the app CTA', () => {
    renderAt('/safety');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(
      screen.getByRole('link', { name: /skip to content/i }),
    ).toHaveAttribute('href', '#main');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(
      within(nav).getByRole('link', { name: 'How it works' }),
    ).toHaveAttribute('href', '/how-it-works');
    expect(within(nav).getByRole('link', { name: 'Safety' })).toHaveAttribute(
      'href',
      '/safety',
    );
    expect(
      screen.getAllByRole('link', { name: 'Open the app' })[0],
    ).toHaveAttribute('href', '/app');
    expect(screen.getByRole('contentinfo')).toHaveTextContent(
      /never controls miners/i,
    );
  });

  it('mobile menu toggles aria-expanded', async () => {
    const user = userEvent.setup();
    renderAt('/');
    const btn = screen.getByRole('button', { name: /open menu/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await user.click(btn);
    expect(screen.getByRole('button', { name: /close menu/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(
      screen.getByRole('navigation', { name: 'Mobile' }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: /open menu/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('landing example card is labelled Example and can preview a replacement', async () => {
    const user = userEvent.setup();
    renderAt('/');
    const card = screen.getByRole('group', { name: /fee check/i });
    expect(within(card).getByText('Example')).toBeInTheDocument();
    expect(within(card).getByText(/not live data/i)).toBeInTheDocument();
    await user.click(
      within(card).getByRole('button', { name: /preview a replacement/i }),
    );
    expect(within(card).getByText('Meets target')).toBeInTheDocument();
  });

  it('FAQ items expand and collapse by keyboard', async () => {
    const user = userEvent.setup();
    renderAt('/');
    const trigger = screen.getByRole('button', {
      name: /does feepilot guarantee/i,
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(
      await screen.findByText(/never controls miners and never promises/i),
    ).toBeInTheDocument();
    await user.keyboard(' ');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('how-it-works has the comparison table', () => {
    renderAt('/how-it-works');
    const table = screen.getByRole('table', { name: /rbf, cpfp and wait/i });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });
});
