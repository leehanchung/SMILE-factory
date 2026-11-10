/**
 * Ambient declarations for the context-bridge globals. FROZEN SHARED FILE.
 *
 * `window.silico` is exposed by src/preload/index.ts to the shell renderer.
 * `window.silicoDesktop` is exposed by src/preload/lab.ts to Lab pages (not
 * present in the shell renderer; declared optional for completeness).
 */
import type { SilicoApi, SilicoDesktopApi } from "./ipc";

declare global {
  interface Window {
    silico: SilicoApi;
    silicoDesktop?: SilicoDesktopApi;
  }
}

export {};
