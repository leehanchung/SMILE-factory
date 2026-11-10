import { BareMetalServer, ChevronLeft, ChevronRight } from "@carbon/icons-react";
import type { Connection, DiscoveredLab, SignedInAuthState } from "@shared/ipc";
import { freshDiscovered } from "../lib/rows";
import type { DiscoveryStatus } from "../lib/types";
import { Avatar } from "./Avatar";
import { EmptyLabDiscoveryMessage } from "./EmptyLabDiscoveryMessage";

/** Step 1 of the add wizard: discovered Labs not yet saved [renderer §4.11]. */
export function ChooseLab(props: {
  discovered: readonly DiscoveredLab[];
  discoveryStatus: DiscoveryStatus;
  onRetryDiscovery: () => void;
  connections: readonly Connection[];
  auth: SignedInAuthState;
  onPick: (lab: DiscoveredLab) => void;
  onSwitchAccount: () => void;
  onCancel: () => void;
}) {
  const { discovered, discoveryStatus, auth } = props;
  const fresh = freshDiscovered(discovered, props.connections);

  let body;
  if (discoveryStatus === "loading") {
    body = <p className="labs__sub">Looking for clusters your account can reach…</p>;
  } else if (discoveryStatus === "unavailable") {
    body = (
      <>
        <p className="labs__sub">Couldn’t check which clusters your account can reach.</p>
        <button type="button" className="btn" onClick={props.onRetryDiscovery}>
          Try again
        </button>
      </>
    );
  } else if (discovered.length === 0) {
    body = (
      <>
        <EmptyLabDiscoveryMessage sub={auth.sub} gatewayUrl={auth.gatewayUrl} />
        <div className="addacct">
          <Avatar login={auth.login} size={34} />
          <div>
            <div className="settings__k">{auth.login}</div>
            <div className="settings__kk">Signed in as this account</div>
          </div>
          <button type="button" className="btn" onClick={props.onSwitchAccount}>
            Switch account
          </button>
        </div>
        <p className="labs__nudge addacct__note">Don’t see one you expected? Reach out to Goodfire on Slack.</p>
      </>
    );
  } else if (fresh.length === 0) {
    body = <p className="labs__sub">You’ve added every cluster your account can reach.</p>;
  } else {
    body = (
      <>
        <p className="labs__sub">Labs your account can reach that you haven’t added yet. Pick one to set it up.</p>
        <ul className="lablist">
          {fresh.map((lab) => (
            <li key={lab.deploymentId}>
              <button type="button" className="labrow labrow--pick" onClick={() => props.onPick(lab)}>
                <span className="labrow__icon" aria-hidden>
                  <BareMetalServer size={16} />
                </span>
                <span className="labrow__main">
                  <span className="labrow__name">{lab.deploymentId}</span>
                  {lab.labPublicHost ? <span className="labrow__host">{lab.labPublicHost}</span> : null}
                </span>
                <ChevronRight size={16} className="labrow__chev" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <div className="pane__inner labs">
      <div className="backbar">
        <button type="button" className="backlink" onClick={props.onCancel}>
          <ChevronLeft size={16} aria-hidden />
          Labs
        </button>
      </div>
      <div className="labs__head labs__head--tight">
        <h1 className="pane__h1">Connect an existing lab</h1>
      </div>
      {body}
    </div>
  );
}
