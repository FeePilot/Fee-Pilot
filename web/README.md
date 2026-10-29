# web

The FeePilot frontend: plain HTML, CSS and ES modules, with no build step and no dependencies.
It only talks to `feepilot-api`, which serves it when `FEEPILOT_WEB_DIR=web` is set.

| File | Purpose |
|---|---|
| `index.html`, `style.css` | Page and theme (follows the system light/dark setting) |
| `app.js` | The flow: txid, analysis, route comparison, PSBT hand-off, live tracking |
| `lib.js` | Pure helpers (query building, labels, timeline), unit-tested in `lib.test.js` |
| `advisor.js` | Offline fee advisor: freshness, estimate by urgency, total fee (`advisor.test.js`) |
| `queue.js` | Offline order notes on IndexedDB and the sync payload (`queue.test.js`) |
| `sw.js` | Service worker: lets the static page open offline; never caches API calls |

The flow: **find** (txid, urgency, budget, what you can sign) -> **compare** (RBF, CPFP, Wait, with
network fee and service charge shown separately; unknown routes are never recommended) ->
**sign** (unsigned PSBT out; paste the wallet-signed PSBT back and tick an explicit approval box
before anything is broadcast) -> **track** (job timeline and tracker history, polled every 4 s).
A job's page is addressable as `#job=<id>`, so a reload or a shared link resumes it.

The **Fee guidance** card keeps the last fee snapshot in `localStorage` and says "Offline mode" when the
API is unreachable; the **Offline orders** card keeps notes in IndexedDB until they can be synced.
Cached data always shows its age and is never presented as live.

No keys are ever entered or stored in the page.

```bash
cd web && npm test     # node --test, no install needed
scripts/demo.sh ui     # regtest node + API + tracker + a stuck transaction; prints the URL
scripts/demo.sh        # the same journey, scripted headlessly over the API
```
