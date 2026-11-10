import { Renew } from "@carbon/icons-react";
import { labRecoveryCopy } from "../lib/copy";
import { Dragstrip } from "./Dragstrip";

/** Full-window card when the open Lab went down [renderer §4.10]. */
export function LabStatePanel(props: {
  managed?: boolean;
  reason?: string;
  onReconnect?: () => void;
  onBack: () => void;
}) {
  const copy = labRecoveryCopy({ managed: props.managed ?? false, reason: props.reason });
  return (
    <div className="centered">
      <Dragstrip />
      <div className="labstate" role={copy.benign ? "status" : undefined}>
        <div className="labstate__icon">
          <Renew size={38} aria-hidden />
        </div>
        <div className="labstate__title">{copy.heading}</div>
        <p className="labstate__sub">{copy.body}</p>
        <div className="labstate__actions">
          <button type="button" className="btn btn--ghost" onClick={props.onBack}>
            Back
          </button>
          {props.onReconnect ? (
            <button type="button" className="btn btn--primary" onClick={props.onReconnect}>
              {copy.action}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
