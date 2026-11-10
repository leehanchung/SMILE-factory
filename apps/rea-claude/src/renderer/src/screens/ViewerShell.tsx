import { useEffect, useState } from "react";
import type { NavState, RecoveryState } from "@shared/ipc";
import { Logo } from "../components/Logo";
import { SignIn } from "../components/SignIn";
import { TitlebarStrip } from "../components/TitlebarStrip";

export const VIEWER_RETRY_FAILED = "Could not restore this page. Please try again.";

/** Viewer window chrome: titlebar + sign-in / recovery card / splash [renderer §4.16]. */
export function ViewerShell() {
  const [title, setTitle] = useState("");
  const [nav, setNav] = useState<NavState>({ canGoBack: false, canGoForward: false });
  const [contentReady, setContentReady] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryState>({ kind: "idle" });

  useEffect(() => window.silico.viewer.onTitle(setTitle), []);
  useEffect(() => window.silico.labView.onNavState(setNav), []);
  useEffect(() => window.silico.viewer.onContentReady(setContentReady), []);
  useEffect(() => window.silico.viewer.onRecovery(setRecovery), []);

  const retry = (deployment?: string): void => {
    window.silico.viewer.retry(deployment).catch(() => {
      setRecovery({ kind: "error", message: VIEWER_RETRY_FAILED });
    });
  };

  let body = null;
  if (recovery.kind === "signin") {
    body = <SignIn staging={recovery.staging} onSignedIn={() => {}} />;
  } else if (recovery.kind === "error" || recovery.kind === "choose") {
    body = (
      <div className="viewer-recovery" role="status">
        <Logo />
        <h1>{recovery.kind === "choose" ? "Choose a Lab" : "Could not restore this page"}</h1>
        <p>{recovery.message}</p>
        {recovery.kind === "choose" ? (
          recovery.deployments.map((d) => (
            <button key={d} type="button" className="btn" onClick={() => retry(d)}>
              {d}
            </button>
          ))
        ) : (
          <button type="button" className="btn" onClick={() => retry()}>
            Try again
          </button>
        )}
      </div>
    );
  } else if (!contentReady) {
    body = (
      <div
        className="viewer-splash"
        role="status"
        aria-label={recovery.kind === "loading" ? recovery.message : "Loading page"}
      >
        <Logo />
      </div>
    );
  }

  return (
    <>
      <TitlebarStrip title={title} nav={nav} />
      {body}
    </>
  );
}
