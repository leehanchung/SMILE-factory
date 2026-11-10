import { useEffect, useState } from "react";
import type { UpdateState } from "@shared/ipc";

/** Current self-update state: one getState() plus the update:state subscription. */
export function useSelfUpdate(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let stale = false;
    window.silico.update
      .getState()
      .then((s) => {
        if (!stale) setState(s);
      })
      .catch(() => {});
    const off = window.silico.update.onState(setState);
    return () => {
      stale = true;
      off();
    };
  }, []);
  return state;
}
