/**
 * Windows module entry (owner: I4). Frozen exports: `createWindowService`,
 * `registerWindowsIpc`. Implementation: ./service.ts (Electron glue) over the
 * pure helpers in ./geometry, ./navPolicy, ./rules, ./menuTemplate,
 * ./watchdog, ./recovery, ./compact, ./persistence.
 *
 * Owns: shell / settings sheet + overlay / viewer / popup windows,
 * initial-window + lastOpened, window-state.json, compact mode, Lab
 * WebContentsView lifecycle, navigation and popup guards, viewer recovery
 * controller + recover-session registry, crash revive, watchdog, power and
 * memory hooks, app + dock + context menus, held labs. IPC: window:is-initial,
 * window:set-compact, window:open-settings-sheet, lastOpened:get/set,
 * labs:held-elsewhere, labs:focus-held, lab:hide, lab:goBack, lab:goForward,
 * viewer:retry, dialog:confirm.
 */
export { createWindowService } from "./service";
export type { WindowsDeps } from "./service";
export { registerWindowsIpc } from "./ipc";
