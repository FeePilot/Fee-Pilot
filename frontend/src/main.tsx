import './styles.css';
import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AppProviders } from '@/app/providers';
import { registerSw } from '@/app/registerSw';
import { AppRoutes } from './routes';

const el = document.getElementById('root');
if (!el) throw new Error('#root is missing');

// Links from the original UI looked like `/#job=<id>`; keep them working.
const legacy = /^#job=([0-9a-f-]{36})$/i.exec(window.location.hash);
// A full navigation, so the prerendered landing page is never hydrated as a job page.
if (legacy) window.location.replace(`/app/jobs/${legacy[1]}`);

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
