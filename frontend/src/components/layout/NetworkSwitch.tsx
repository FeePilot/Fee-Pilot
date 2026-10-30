import { useEffect, useState } from 'react';
import { useNetworks } from '@/api/hooks';
import type { Network } from '@/api/schemas';
import { cn } from '@/lib/cn';
import { activeNetwork, selectNetwork } from '@/lib/network';

/** Switching reloads the app, so no cached data, query or queued order carries over. */
function reload() {
  try {
    window.location.reload();
  } catch {
    // Not available outside a browser.
  }
}

/**
 * Switch between the networks the server offers. Renders nothing when there is only one, so
 * the plain network badge stays in that case. A saved choice the server no longer offers is
 * dropped.
 */
export function NetworkSwitch() {
  const { data } = useNetworks();
  const catalog = data?.ok ? data.body : null;
  const [chosen, setChosen] = useState(activeNetwork);
  const stale =
    catalog !== null &&
    chosen !== null &&
    !catalog.networks.includes(chosen as Network);

  useEffect(() => {
    if (stale && catalog) {
      selectNetwork(catalog.default, catalog.default);
      reload();
    }
  }, [stale, catalog]);

  if (!catalog || catalog.networks.length < 2 || stale) return null;
  const current = chosen ?? catalog.default;

  return (
    <div
      role="group"
      aria-label="Network"
      className="inline-flex gap-0.5 rounded-full border border-line bg-surface-2/70 p-0.5"
    >
      {catalog.networks.map((n) => {
        const on = n === current;
        return (
          <button
            key={n}
            type="button"
            aria-pressed={on}
            onClick={() => {
              if (on) return;
              selectNetwork(n, catalog.default);
              setChosen(activeNetwork());
              reload();
            }}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              on ? 'bg-solid text-fg shadow-sm' : 'text-muted hover:text-fg',
              on && n === 'mainnet' && 'text-bad',
            )}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}
