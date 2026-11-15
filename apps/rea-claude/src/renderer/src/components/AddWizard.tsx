import { useState } from "react";
import type { Connection, ConnectionUpsert, DiscoveredLab, SignedInAuthState } from "@shared/ipc";
import { draftFromDiscovered } from "../lib/rows";
import type { DiscoveryStatus } from "../lib/types";
import { ChooseLab } from "./ChooseLab";
import { ConfigureForm } from "./ConfigureForm";

/** ChooseLab -> ConfigureForm (wizard mode) [renderer §4.11]. */
export function AddWizard(props: {
  discovered: readonly DiscoveredLab[];
  discoveryStatus: DiscoveryStatus;
  onRetryDiscovery: () => void;
  connections: readonly Connection[];
  auth: SignedInAuthState;
  initialPick?: DiscoveredLab;
  onSwitchAccount: () => void;
  onSave: (draft: ConnectionUpsert) => Promise<void>;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<DiscoveredLab | null>(props.initialPick ?? null);
  if (picked) {
    return (
      <ConfigureForm
        key={picked.deploymentId}
        initial={draftFromDiscovered(picked, props.connections)}
        onBack={() => setPicked(null)}
        onCancel={props.onCancel}
        onSave={props.onSave}
      />
    );
  }
  return (
    <ChooseLab
      discovered={props.discovered}
      discoveryStatus={props.discoveryStatus}
      onRetryDiscovery={props.onRetryDiscovery}
      connections={props.connections}
      auth={props.auth}
      onPick={setPicked}
      onSwitchAccount={props.onSwitchAccount}
      onCancel={props.onCancel}
    />
  );
}
