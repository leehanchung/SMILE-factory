/**
 * Settings module entry (owner: I6). settings.json read/sanitize/serialized
 * write/change listeners (platform §4.1) and the settings:get / settings:set
 * IPC. `set` broadcasts `settings:changed` to every window (via
 * ctx.windows.broadcast) only after a successful write; listeners registered
 * with `onChanged` (I4 developer menu + devtools close, I5 badge recompute)
 * run inside the write, before the broadcast.
 */
import { join } from "node:path";
import { FILE_SETTINGS } from "@shared/config";
import { ShellInvokeChannel } from "@shared/ipc";
import { handleShell } from "../ipc/trust";
import type { MainContext, SettingsService } from "../services";
import { createSettingsStore } from "./store";
import type { SettingsFs } from "./store";

export interface SettingsDeps {
  /** Override the settings.json path (default `<userData>/settings.json`). */
  filePath?: () => string;
  /** Injectable fs (tests). */
  fs?: SettingsFs;
}

export function createSettingsService(ctx: MainContext, deps?: SettingsDeps): SettingsService {
  // Lazy: userData is only valid after the pre-ready bootstrap ran setPath.
  const store = createSettingsStore({
    filePath: deps?.filePath ?? (() => join(ctx.env.userDataPath(), FILE_SETTINGS)),
    fs: deps?.fs,
    log: {
      debug: (...a) => ctx.logger("settings").debug(...a),
      info: (...a) => ctx.logger("settings").info(...a),
      warn: (...a) => ctx.logger("settings").warn(...a),
      error: (...a) => ctx.logger("settings").error(...a),
    },
  });
  return {
    get: () => store.get(),
    set: (patch) => store.set(patch),
    onChanged: (listener) => store.onChanged(listener),
  };
}

export function registerSettingsIpc(ctx: MainContext): void {
  handleShell(ShellInvokeChannel.settingsGet, () => ctx.settings.get());
  handleShell(ShellInvokeChannel.settingsSet, async (_e, patch) => {
    // A rejected write propagates to the renderer and nothing is broadcast.
    const merged = await ctx.settings.set(patch);
    ctx.windows.broadcast("settings:changed", merged);
    return merged;
  });
}
