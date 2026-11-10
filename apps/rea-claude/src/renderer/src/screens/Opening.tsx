/** Opening / Lab loading / launch-gate screens [renderer §4.4, §4.7, §4.8]. */
import { WarningAltFilled } from "@carbon/icons-react";
import type { Connection } from "@shared/ipc";
import { HostKeyPanel } from "../components/HostKeyPanel";
import { Logo } from "../components/Logo";
import { ProgressPanel } from "../components/ProgressPanel";
import { isOpeningFailed } from "../lib/connect";
import { STILL_WAKING_MESSAGE, failureMessage, phaseStatus } from "../lib/copy";
import type { ConnState, LabModel } from "../lib/types";

function Console({ cs, onHide }: { cs: ConnState | undefined; onHide: () => void }) {
  return (
    <div className="opening__console">
      <ProgressPanel cs={cs} onHide={onHide} />
    </div>
  );
}

/** Phase sentence, keyed by its text so the entrance animation replays on change. */
function PhaseLine({ text }: { text: string }) {
  return (
    <p key={text} className="opening__phase">
      {text}
    </p>
  );
}

export function OpeningScreen(props: {
  conn: Connection;
  cs: ConnState;
  showLog: boolean;
  setShowLog: (open: boolean) => void;
  onRetry: () => void;
  onSwitchAccount: () => void;
  /** Failure / still-starting: just leave (no cancel). */
  onDismiss: () => void;
  /** In progress / host-key: cancel the flow. */
  onCancel: () => void;
  onHostKeyAccepted: () => void;
}) {
  const { conn: c, cs, showLog, setShowLog } = props;
  const failed = isOpeningFailed(cs.phase);
  const hostKey = cs.phase === "host-key" && !!c.ssh;
  const stillWaking = cs.phase === "still-waking";
  const working = !hostKey && !failed && !stillWaking;
  const hideLog = (): void => setShowLog(false);

  let main;
  if (hostKey && c.ssh) {
    main = (
      <div className="opening__hk">
        <HostKeyPanel ssh={c.ssh} kind={cs.hostKeyKind ?? "unknown"} onAccepted={props.onHostKeyAccepted} />
        <div className="opening__actions">
          <button type="button" className="btn btn--ghost" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  } else if (failed) {
    main = (
      <div className="opening__fail" role="alert">
        <WarningAltFilled size={20} aria-hidden className="opening__fail-icon" />
        <h2 className="opening__fail-title">Couldn't open {c.name || c.deploymentId || "this Lab"}</h2>
        <p className="opening__fail-msg">{failureMessage(cs.phase, cs.message)}</p>
        <div className="opening__actions">
          {cs.phase === "forbidden" ? (
            <button type="button" className="btn" onClick={props.onSwitchAccount}>
              Switch account
            </button>
          ) : null}
          <button type="button" className="btn btn--primary" onClick={props.onRetry}>
            Retry
          </button>
        </div>
        <div className="opening__actions opening__actions--secondary">
          <button type="button" className="linkaction" onClick={props.onDismiss}>
            Open a different lab
          </button>
        </div>
      </div>
    );
  } else if (stillWaking) {
    main = (
      <div className="opening__fail" role="status">
        <h2 className="opening__fail-title">Still starting</h2>
        <p className="opening__fail-msg">{cs.message ?? STILL_WAKING_MESSAGE}</p>
        <div className="opening__actions">
          <button type="button" className="btn btn--primary" onClick={props.onRetry}>
            Try again
          </button>
        </div>
        <div className="opening__actions opening__actions--secondary">
          <button type="button" className="linkaction" onClick={props.onDismiss}>
            Open a different lab
          </button>
        </div>
      </div>
    );
  } else {
    const name = c.name || c.deploymentId || "Lab";
    main = (
      <>
        <div className="opening__center">
          <Logo className="opening__logo" />
          <div className="opening__title">{cs.phase === "updating" ? `Updating ${name}` : `Opening ${name}`}</div>
          <PhaseLine key={phaseStatus(cs.phase)} text={phaseStatus(cs.phase)} />
          <div className="opening__track" aria-hidden />
          {showLog ? <Console cs={cs} onHide={hideLog} /> : null}
        </div>
        <div className="opening__footer">
          <button type="button" className="linkaction" onClick={props.onCancel}>
            Open a different lab
          </button>
          <span className="opening__sep" aria-hidden>
            •
          </span>
          <button type="button" className="opening__logs" onClick={() => setShowLog(!showLog)}>
            {showLog ? "Hide logs" : "View logs"}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className={working ? "opening opening--loading" : "opening"}>
      {main}
      {failed || stillWaking ? (
        showLog ? (
          <Console cs={cs} onHide={hideLog} />
        ) : (
          <button type="button" className="opening__logs" onClick={() => setShowLog(true)}>
            View logs
          </button>
        )
      ) : null}
    </div>
  );
}

export function LabLoadingScreen(props: {
  lab: LabModel;
  cs: ConnState | undefined;
  waking: boolean;
  logOpen: boolean;
  setLogOpen: (open: boolean) => void;
  onLeave: () => void;
}) {
  const { lab, cs, logOpen } = props;
  const status = phaseStatus(props.waking || cs?.phase === "waking" ? "waking" : cs?.phase);
  return (
    <div className="opening opening--loading">
      <div className="opening__center">
        <Logo className="opening__logo" />
        <div className="opening__title">{`Opening ${lab.title}`}</div>
        <PhaseLine key={status} text={status} />
        <div className="opening__track" aria-hidden />
        {cs && logOpen ? <Console cs={cs} onHide={() => props.setLogOpen(false)} /> : null}
      </div>
      <div className="opening__footer">
        <button type="button" className="linkaction" onClick={props.onLeave}>
          Open a different lab
        </button>
        {cs ? (
          <>
            <span className="opening__sep" aria-hidden>
              •
            </span>
            <button type="button" className="opening__logs" onClick={() => props.setLogOpen(!logOpen)}>
              {logOpen ? "Hide logs" : "View logs"}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

const hidden = { visibility: "hidden" } as const;

/** Layout-reserving placeholder while auto-open decides (logo only visible). */
export function LaunchGate() {
  return (
    <div className="opening opening--loading">
      <div className="opening__center">
        <Logo className="opening__logo" />
        <div className="opening__title" aria-hidden style={hidden}>
          Opening
        </div>
        <p className="opening__phase" aria-hidden style={hidden}>
          Connecting to your lab…
        </p>
        <div className="opening__track" aria-hidden style={hidden} />
      </div>
      <div className="opening__footer" aria-hidden style={hidden}>
        <button type="button" className="linkaction" tabIndex={-1}>
          Open a different lab
        </button>
        <span className="opening__sep">•</span>
        <button type="button" className="opening__logs" tabIndex={-1}>
          View logs
        </button>
      </div>
    </div>
  );
}
