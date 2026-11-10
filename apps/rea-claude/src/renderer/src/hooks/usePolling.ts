import { useEffect, useRef } from "react";

/**
 * Run `fn` immediately and every `intervalMs` while `enabled`; optionally on
 * window focus too. The latest `fn` is always used; `deps` restart the cycle.
 */
export function usePolling(
  fn: () => void,
  intervalMs: number,
  enabled: boolean,
  opts: { onFocus?: boolean; deps?: readonly unknown[] } = {},
): void {
  const ref = useRef(fn);
  ref.current = fn;
  const onFocus = opts.onFocus ?? false;
  useEffect(() => {
    if (!enabled) return undefined;
    const run = (): void => ref.current();
    run();
    const t = window.setInterval(run, intervalMs);
    if (onFocus) window.addEventListener("focus", run);
    return () => {
      window.clearInterval(t);
      if (onFocus) window.removeEventListener("focus", run);
    };
  }, [enabled, intervalMs, onFocus, ...(opts.deps ?? [])]);
}
