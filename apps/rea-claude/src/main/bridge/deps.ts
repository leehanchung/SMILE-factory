/** Injectable clock and timers for the bridge / telemetry services (tests). */
export interface BridgeDeps {
  /** Wall clock in ms (default `Date.now()`). */
  now?: () => number;
  /** Default: global `setTimeout` (resolved at call time, so fake timers apply). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Default: global `clearTimeout`. */
  clearTimeout?: (handle: unknown) => void;
}

export interface ResolvedDeps {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export function resolveDeps(deps: BridgeDeps | undefined): ResolvedDeps {
  return {
    now: deps?.now ?? (() => Date.now()),
    setTimeout:
      deps?.setTimeout ??
      ((fn, ms) => {
        const h = setTimeout(fn, ms);
        (h as { unref?: () => void }).unref?.();
        return h;
      }),
    clearTimeout: deps?.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
  };
}
