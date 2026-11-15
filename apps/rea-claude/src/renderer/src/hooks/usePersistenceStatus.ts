import { useEffect, useState } from "react";
import type { PersistenceMode } from "@shared/ipc";

/** auth.persistence(), read once per mount. */
export function usePersistenceStatus(): PersistenceMode | null {
  const [mode, setMode] = useState<PersistenceMode | null>(null);
  useEffect(() => {
    let stale = false;
    window.silico.auth
      .persistence()
      .then((m) => {
        if (!stale) setMode(m);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);
  return mode;
}
