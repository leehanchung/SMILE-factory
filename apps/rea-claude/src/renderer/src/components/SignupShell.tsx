import { ArrowLeft } from "@carbon/icons-react";
import { Logo } from "./Logo";

/** Header bar drawn above main's signup web view [renderer §4.3]. */
export function SignupShell({ staging, onBack }: { staging: boolean; onBack: () => void }) {
  return (
    <div className="signup-shell">
      <header className="signup-shell__bar">
        <button type="button" className="signup-shell__back" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden />
          Back
        </button>
        <div className="signup-shell__title">
          <Logo alt="Goodfire" />
        </div>
        {staging ? <span className="signup-shell__env">Staging beta</span> : null}
      </header>
    </div>
  );
}
