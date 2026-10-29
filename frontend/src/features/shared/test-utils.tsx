import { render } from '@testing-library/react';
import { MotionConfig } from 'motion/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '@/components/ui/Toast';

/** jsdom lacks a few DOM APIs that Radix Select and scrolling call. */
export function stubDom() {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  URL.createObjectURL ??= () => 'blob:test';
  URL.revokeObjectURL ??= () => {};
}

export function renderApp(ui: React.ReactElement, route = '/') {
  stubDom();
  return render(
    <HelmetProvider>
      <MotionConfig reducedMotion="always">
        <ToastProvider>
          <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
        </ToastProvider>
      </MotionConfig>
    </HelmetProvider>,
  );
}
