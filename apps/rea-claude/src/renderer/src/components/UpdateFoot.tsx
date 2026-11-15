import { useSelfUpdate } from "../hooks/useSelfUpdate";
import type { UpdateState } from "@shared/ipc";

function versionText(state: UpdateState | null): string {
  return `Version ${state?.currentVersion || "—"}`;
}

/** "Update ready" banner, only when an update has been downloaded. */
export function RestartFoot({ state }: { state: UpdateState | null }) {
  if (state?.phase !== "downloaded") return null;
  return (
    <div className="foot foot--banner">
      <div className="foot__title">Update ready</div>
      <p className="foot__sub">Restart to apply the new version.</p>
      <button
        type="button"
        className="linkbtn foot__restart"
        onClick={() => {
          void window.silico.update.install().catch(() => {});
        }}
      >
        Restart to update
      </button>
    </div>
  );
}

/** App rail / picker: banner only. */
export function UpdateReadyFoot() {
  const state = useSelfUpdate();
  return <RestartFoot state={state} />;
}

/** App rail account block version label. */
export function RailVersion() {
  const state = useSelfUpdate();
  return <div className="rail__ver">{versionText(state)}</div>;
}

/** Settings sheet footer: banner + version. */
export function UpdateFooter() {
  const state = useSelfUpdate();
  return (
    <>
      <RestartFoot state={state} />
      <div className="foot">
        <div className="foot__ver">{versionText(state)}</div>
      </div>
    </>
  );
}
