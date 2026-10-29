import { useEffect, useState } from 'react';

/** The current time in unix seconds, refreshed on an interval so ages keep ticking. */
export function useNowSecs(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      everyMs,
    );
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}
