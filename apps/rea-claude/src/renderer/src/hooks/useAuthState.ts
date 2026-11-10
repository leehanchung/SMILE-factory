import { useEffect, useState } from "react";
import type { AuthState, Settings } from "@shared/ipc";

/** auth.status() + auth:changed (settings sheet; App manages auth itself). */
export function useAuthState(): AuthState | undefined {
  const [auth, setAuth] = useState<AuthState | undefined>(undefined);
  useEffect(() => {
    let stale = false;
    window.silico.auth
      .status()
      .then((s) => {
        if (!stale) setAuth(s);
      })
      .catch(() => {});
    const off = window.silico.auth.onChanged(setAuth);
    return () => {
      stale = true;
      off();
    };
  }, []);
  return auth;
}

/** settings.get() + settings:changed, with a setter for set() replies. */
export function useSettingsState(): [Settings | null, (s: Settings) => void] {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let stale = false;
    window.silico.settings
      .get()
      .then((s) => {
        if (!stale) setSettings(s);
      })
      .catch(() => {});
    const off = window.silico.settings.onChanged(setSettings);
    return () => {
      stale = true;
      off();
    };
  }, []);
  return [settings, setSettings];
}
