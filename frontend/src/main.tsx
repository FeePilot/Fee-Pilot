import './styles.css';
import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AppProviders } from '@/app/providers';
import { registerSw } from '@/app/registerSw';
import { AppRoutes } from './routes';

const el = document.getElementById('root');
if (!el) throw new Error('#root is missing');

const app = (
  <StrictMode>
    <AppProviders>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProviders>
  </StrictMode>
);

// Prerendered marketing pages arrive with content and are hydrated; the app shell is empty.
if (el.hasChildNodes()) hydrateRoot(el, app);
else createRoot(el).render(app);

registerSw();
