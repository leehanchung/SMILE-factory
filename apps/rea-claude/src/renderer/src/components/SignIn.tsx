import { useEffect, useRef, useState } from "react";
import { LEGAL_PRIVACY_URL, LEGAL_TOS_URL, SIGN_IN_RETRY_COOLDOWN_MS } from "@shared/config";
import type { AuthState } from "@shared/ipc";
import { Dragstrip } from "./Dragstrip";
import { KeyringNotice } from "./KeyringNotice";
import { Logo } from "./Logo";

/**
 * Welcome / sign-in card [renderer §4.2]. Single-flight: "Sign in" is
 * ignored while an attempt is in flight; "Try again" forces a new attempt
 * (after which results of older attempts are dropped).
 */
export function SignIn({ staging, onSignedIn }: { staging: boolean; onSignedIn: (s: AuthState) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cooldown, setCooldown] = useState(false);
  const attempt = useRef(0);
  const inFlight = useRef(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    },
    [],
  );

  const go = async (force: boolean): Promise<void> => {
    if (inFlight.current && !force) return;
    inFlight.current = true;
    const id = ++attempt.current;
    setBusy(true);
    setError("");
    try {
      const state = await window.silico.auth.signIn(staging, force);
      if (id !== attempt.current) return;
      onSignedIn(state);
    } catch (e) {
      if (id !== attempt.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      inFlight.current = false;
    }
  };

  const restart = (): void => {
    setCooldown(true);
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    cooldownTimer.current = setTimeout(() => setCooldown(false), SIGN_IN_RETRY_COOLDOWN_MS);
    void go(true);
  };

  return (
    <div className="gate">
      <Dragstrip />
      <div className="gate__card">
        <Logo className="gate__logo" />
        <h1 className="gate__title">Welcome to Silico</h1>
        <p className="gate__intro">Sign-in opens in your browser.</p>
        {staging ? <div className="gate__env">Staging environment</div> : null}
        {error ? <div className="gate__error">{error}</div> : null}
        <div className="gate__actions">
          <button type="button" className="btn btn--primary gate__btn" disabled={busy} onClick={() => void go(false)}>
            {busy ? "Waiting for your browser…" : "Sign in"}
          </button>
        </div>
        {busy ? (
          <p className="gate__waiting">
            Complete sign-in in your browser, then return here. Hit a snag?{" "}
            <button type="button" className="linkbtn" disabled={cooldown} onClick={restart}>
              {cooldown ? "Opening browser…" : "Try again"}
            </button>
          </p>
        ) : null}
        <KeyringNotice surface="gate" />
        <p className="gate__terms">
          By signing in, I agree to the{" "}
          <a href={LEGAL_TOS_URL} target="_blank" rel="noreferrer">
            Silico Terms of Use
          </a>{" "}
          and confirm that I have read Goodfire's{" "}
          <a href={LEGAL_PRIVACY_URL} target="_blank" rel="noreferrer">
            Privacy Policy
          </a>
          . I understand that Goodfire may send me marketing emails, which I can unsubscribe from at any time.
        </p>
        <p className="gate__terms">
          If my organization has a separate written agreement with Goodfire governing its use of any Goodfire product or
          service, that agreement applies instead.
        </p>
      </div>
    </div>
  );
}
