import { useLayoutEffect, useRef } from "react";
import { isRunningPhase } from "../lib/connect";
import { PHASE_LABEL } from "../lib/copy";
import { fmtElapsed, shapeLog } from "../lib/log";
import type { ConnState } from "../lib/types";

/** Connect log console with phase label, elapsed timer, Copy log and Hide. */
export function ProgressPanel({ cs, onHide, now }: { cs: ConnState | undefined; onHide: () => void; now?: number }) {
  const preRef = useRef<HTMLPreElement>(null);
  const shaped = cs ? shapeLog(cs.log) : "";
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [shaped]);
  const running = !!cs && isRunningPhase(cs.phase);
  const label = cs ? PHASE_LABEL[cs.phase] : "Idle";
  const elapsed = running && cs ? ` · ${fmtElapsed((now ?? Date.now()) - cs.startedAt)}` : "";
  return (
    <div className="panel">
      <div className="panel__bar">
        <span className="panel__phase">
          {label}
          {elapsed}
        </span>
        <div className="panel__actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void navigator.clipboard?.writeText(shaped).catch(() => {});
            }}
          >
            Copy log
          </button>
          <button type="button" className="btn" onClick={onHide}>
            Hide
          </button>
        </div>
      </div>
      <pre className="console" ref={preRef}>
        {shaped || "(no output yet)"}
      </pre>
    </div>
  );
}
