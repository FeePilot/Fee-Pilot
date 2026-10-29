# frontend: contract for everyone working in this folder

FeePilot's React app. **Vite 7, React 19, strict TypeScript, Tailwind v4, Radix, motion (Framer Motion),
TanStack Query, react-hook-form + zod, react-helmet-async, vite-plugin-pwa.** The Rust API serves the
build (`FEEPILOT_WEB_DIR=frontend/dist`). The old UI in `../web/` and the `/v1` API stay untouched.

Commands (run from `frontend/`; pnpm lives at `~/.cache/node/corepack/v1/pnpm/12.5.1/pnpm`):
`node_modules/.bin/tsc --noEmit` · `node_modules/.bin/vitest run` · `node_modules/.bin/vite build`.

## Rules

- **Do not commit.** Do not touch `../web/`, `../crates/`, `../scripts/`, or files you do not own.
- No new dependencies unless unavoidable; if you add one, say so in your report.
- Strict TS: `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (use `import type`), no `any`.
- **Honest copy.** FeePilot never guarantees confirmation, never holds keys, never broadcasts without
  approval. A cached fee is never presented as live; a local note is not proof of payment; "not seen by
  this node" never means "does not exist". No invented stats, testimonials, logos, prices or claims.
- **Motion is for clarity, not decoration.** Use tokens from `@/lib/motion`. Keep the sign/approve steps calm.
  Everything must work with `prefers-reduced-motion` (`MotionConfig reducedMotion="user"` is set).
- **SSR-safe marketing pages:** they are prerendered with `renderToString`. No `window`/`document`/
  `localStorage` at render time (use effects). Scroll reveals use `data-reveal` so `.no-js` can undo them.
- Accessibility: semantic landmarks, labelled controls, visible focus, AA contrast, keyboard operable.
- Tests: Vitest + Testing Library in `src/**/*.test.ts(x)`.

## Layout and ownership

| Area                                         | Files                                                                                                                                                                                      | Owner             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| Foundation, UI kit, theme, providers, routes | `src/lib/{cn,motion}.ts`, `src/lib/api/{envelope,client}.ts`, `src/components/ui/*`, `src/components/theme/*`, `src/app/providers.tsx`, `src/routes.tsx`, `src/styles.css`, `src/main.tsx` | lead              |
| Data layer                                   | `src/api/*`, `src/lib/{advisor,queue,analysis,format,storage}.ts` (+tests)                                                                                                                 | agent `data`      |
| SEO + build pipeline                         | `src/seo/{pages,jsonld}.ts`, `scripts/prerender.mjs`, `vite.config.ts` (PWA section only), `public/*` (not theme-init/favicon)                                                             | agent `seo`       |
| Marketing                                    | `src/pages/marketing/*`, `src/pages/NotFound.tsx`, `src/components/layout/{MarketingLayout,Navbar,Footer}.tsx`, `src/components/marketing/*`                                               | agent `marketing` |
| App                                          | `src/pages/app/*`, `src/components/layout/AppLayout.tsx`, `src/features/**`                                                                                                                | agent `app`       |

`src/seo/Seo.tsx`, `src/components/background/Backdrop.tsx` and the UI kit are lead-owned: import them, ask for changes in your report.

## UI kit (import paths and props)

- `Button` (`@/components/ui/Button`): `variant: 'primary'|'secondary'|'ghost'|'danger'`, `size: 'sm'|'md'|'lg'`, `loading?`, plus button props. `buttonStyles({variant,size,className})` styles a `<Link>`.
- `Card`: `interactive?`, `glow?`, div props. `Pill`: `tone: 'neutral'|'accent'|'ok'|'warn'|'bad'|'info'`.
- `Modal` (`open`, `onOpenChange`, `title`, `description?`, `footer?`, children). Radix Dialog with motion.
- `useToast()` -> `toast({ title, description?, tone?: 'ok'|'warn'|'bad'|'info' })`.
- `CountUp({ value, format?, className? })`, `Gauge({ rate, target })`, `Stepper({ steps, current })` (current is 1-based), `Skeleton`.
- Forms (`@/components/ui/form`): `FormInput`, `FormSelect`, `FormToggleGroup`, `FormCheckbox`, each takes `control`, `name`, `label`, `hint?`;
  select/toggle take `options: {value,label}[]`. Pattern: string form values, zod transforms,
  `useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({ resolver: zodResolver(schema), mode: 'onTouched' })`.
  Radix Select forbids empty-string item values: use `'unknown'` for "not sure".
- Icons: `@/components/ui/icons`. Theme: `useTheme()` and `<ThemeToggle />` (`@/components/theme/*`).
- Tailwind tokens: `bg-bg bg-raised bg-surface bg-solid bg-surface-2 border-line border-line-strong text-fg text-muted text-accent bg-accent text-ok/warn/bad/info (+ -bg)`, `shadow-card shadow-glow rounded-card font-mono`.
- Motion tokens: `spring.{soft,snappy,press}`, `ease.out`, `duration.*`, variants `fadeUp`, `fade`, `scaleIn`, `page`, `stagger(gap, delay)`.
- `<Backdrop fixed? />` is the page background (CSS gradients). A WebGL starfield may later render on top of it; do not build that.

## API (the `/v2` envelope)

Every `/v2` response is `{ status, message, body }`. `request(path, zodSchema, {method, json})` in `@/lib/api/client`
returns `ApiResult<T>` = `{ ok: true, status, message, body } | { ok: false, status, message, code }` and never throws
(`status: 0, code: 'network_error'` when unreachable; `'bad_response'` when the body fails validation).
Error codes: `bad_request`, `unprocessable`, `not_found`, `conflict`, `rate_limited`, `node_unreachable`,
`node_misconfigured`, `node_bad_response`, `node_error`, `internal_error`.

Endpoints (all under `/v2`): `GET /fees` (refresh; 200 + `refresh.ok:false` when the node is down but a snapshot is saved),
`GET /fees/latest`, `POST /orders/sync`, `GET /analyze/{txid}?urgency&max_budget_sat&can_sign_inputs&controls_output&output_value_sat`,
`POST /jobs/rbf`, `POST /jobs/cpfp`, `GET /jobs/{id}`, `GET /jobs/{id}/history`, `POST /jobs/{id}/submit`.
The exact JSON shapes are the Rust structs: `crates/feepilot-core/src/{types,strategy,snapshot}.rs`,
`crates/feepilot-store/src/{lib,orders}.rs`, `crates/feepilot-api/src/lib.rs`. The old client in `../web/*.js` shows how each is used.

## Data layer contract (`src/api/`)

`schemas.ts`: zod schemas + inferred types: `feesBodySchema`/`FeesBody` (`snapshot|null`, `last_error|null`, `policy`, `server_time`, `refresh?`),
`recommendationSchema`/`Recommendation`, `jobCreatedSchema`, `jobSchema`/`Job`, `historySchema`, `syncBodySchema`.
`hooks.ts` (TanStack Query; mutations resolve to `ApiResult`, never reject):

- `useFees()` -> `{ fees: { snapshot, policy } | null, clockOffsetSecs: number, state: 'loading'|'live'|'degraded'|'offline', error: string|null, refresh(): Promise<void> }`.
  Persists the last good snapshot + policy + clock offset to localStorage (safe, try/catch). `clockOffsetSecs = server_time - Date.now()/1000` at fetch time,
  so snapshot age is measured on the server's clock, not the device's.
- `useAnalyze()` -> mutation `(input: AnalyzeInput) => ApiResult<Recommendation>`.
- `useCreateJob()` -> mutation `(input: {kind:'rbf', ...} | {kind:'cpfp', ...}) => ApiResult<JobCreated>`.
- `useSubmitJob(id)` -> mutation `(signedPsbt: string) => ApiResult<Job>`.
- `useJob(id)` -> `{ job: Job|null, history: HistoryEntry[], result: ApiResult<Job>|null }`, polls every 4 s while the job state is active.
- `useOrders()` -> `{ orders, add(input): Promise<{ok:true}|{ok:false,error:string}>, remove(id), sync(): Promise<void>, syncing: boolean, message: string, persistent: boolean }` over IndexedDB (memory fallback).
- `useOnline()` -> boolean (browser online event + last API reachability).
  Pure logic lives in `src/lib/{advisor,queue,analysis,format}.ts` and is unit-tested.
