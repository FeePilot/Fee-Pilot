// Which network the app is looking at. The server can serve several (see `/v2/networks`); the
// choice is kept in localStorage and every `/v2` call and piece of local data is scoped to it, so
// networks never mix. No saved choice means the server's default network, which keeps the
// original, unscoped storage keys.

import { readItem, removeItem, writeItem } from './storage';

const KEY = 'feepilot.network.v1';

/** The network the user switched to, or null for the server's default. */
export function activeNetwork(): string | null {
  const v = readItem(KEY);
  return v !== null && /^[a-z]+$/.test(v) ? v : null;
}

/** Remember the choice. Picking the default network clears it, so default data stays under its original keys. */
export function selectNetwork(next: string, defaultNetwork: string): void {
  if (next === defaultNetwork) removeItem(KEY);
  else writeItem(KEY, next);
}

/** A storage key or database name for the active network. */
export function scopedKey(base: string): string {
  const net = activeNetwork();
  return net === null ? base : `${base}.${net}`;
}

/** Route a `/v2` path to the active network's API. `/v2/networks` is the same for all. */
export function apiPath(path: string): string {
  const net = activeNetwork();
  if (
    net === null ||
    !path.startsWith('/v2/') ||
    path.startsWith('/v2/networks')
  )
    return path;
  return `/net/${net}${path}`;
}
