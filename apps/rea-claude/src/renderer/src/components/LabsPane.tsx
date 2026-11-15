/** Labs list, empty state, "New lab" menu and local dev stacks [renderer §4.5]. */
import { Add, BareMetalServer, Laptop } from "@carbon/icons-react";
import type { MouseEvent, ReactNode } from "react";
import type { Connection, DiscoveredLab, LocalStack } from "@shared/ipc";
import { localStackConnection, localStackName } from "../lib/localDev";
import { rowLabel, sortDiscovered } from "../lib/rows";
import type { DiscoveryStatus } from "../lib/types";
import { ConnIcon } from "./ConnIcon";
import { OverflowMenu } from "./OverflowMenu";
import type { MenuItem } from "./OverflowMenu";

/** Click on a row, except inside a button or an overflow menu. */
function isRowClick(e: MouseEvent, ignore: string): boolean {
  const t = e.target as Element | null;
  return !t?.closest?.(ignore);
}

export function LabActionsMenu(props: { onConnectExisting: () => void; onCreate: () => void; onOpen: () => void }) {
  return (
    <div className="labs__actions">
      <OverflowMenu
        triggerClassName="btn"
        triggerLabel="Add a lab"
        onOpenChange={(o) => {
          if (o) props.onOpen();
        }}
        trigger={
          <>
            <Add size={16} aria-hidden />
            New lab
          </>
        }
        items={[
          { label: "Connect an existing lab", onClick: props.onConnectExisting },
          { label: "Create a new lab", onClick: props.onCreate },
        ]}
      />
    </div>
  );
}

export function LocalStacksSection(props: {
  stacks: readonly LocalStack[];
  heldElsewhere: readonly string[];
  onOpen: (c: Connection) => void;
}) {
  return (
    <section className="addlocal">
      <h2 className="labs__subhead">Local dev stacks</h2>
      <ul className="lablist">
        {props.stacks.map((st) => {
          const c = localStackConnection(st);
          return (
            <li
              key={st.project}
              className="labrow labrow--stacked"
              onClick={(e) => {
                if (isRowClick(e, "button")) props.onOpen(c);
              }}
            >
              <span className="labrow__icon" aria-hidden>
                <Laptop size={16} />
              </span>
              <span className="labrow__main">
                <span className="labrow__titlerow">
                  <span className="labrow__name">{localStackName(st)}</span>
                  {props.heldElsewhere.includes(c.id) ? (
                    <span className="labrow__pill labrow__pill--open">Already open</span>
                  ) : null}
                </span>
                <span className="labrow__host">localhost:{st.port}</span>
              </span>
              <span className="labrow__actions">
                <button type="button" className="btn labrow__open" onClick={() => props.onOpen(c)}>
                  Open
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function LabsEmpty(props: {
  head: ReactNode;
  discoveryStatus: DiscoveryStatus;
  discovered: readonly DiscoveredLab[];
  onAddDiscovered: (lab: DiscoveredLab) => void;
  local: ReactNode;
}) {
  const ok = props.discoveryStatus === "ok";
  return (
    <div className="pane__inner labs">
      {props.head}
      <p className="labs__question">Where do you want to research?</p>
      {ok && props.discovered.length > 0 ? (
        <ul className="lablist">
          {sortDiscovered(props.discovered).map((lab) => (
            <li key={lab.deploymentId} className="labrow labrow--disc">
              <span className="labrow__icon" aria-hidden>
                <BareMetalServer size={16} />
              </span>
              <span className="labrow__name labrow__name--muted">{lab.deploymentId}</span>
              <button type="button" className="linkbtn labrow__addlink" onClick={() => props.onAddDiscovered(lab)}>
                Add
              </button>
            </li>
          ))}
        </ul>
      ) : ok ? (
        <p className="labs__nudge">Create a new lab (top right), or use “Add lab” to connect an existing one.</p>
      ) : null}
      {props.local}
    </div>
  );
}

export interface RowModel {
  conn: Connection;
  failed: boolean;
  heldOpen: boolean;
  /** Show the "Update available" hint. */
  updateHint: boolean;
  versionLines?: string[];
  menuItems: MenuItem[];
}

export function LabsList(props: {
  head: ReactNode;
  rows: readonly RowModel[];
  local: ReactNode;
  menuFor: string | null;
  setMenuFor: (id: string | null) => void;
  onOpen: (c: Connection) => void;
}) {
  return (
    <div className="pane__inner labs">
      {props.head}
      {props.local ? <h2 className="labs__subhead labs__subhead--first">Saved labs</h2> : null}
      <ul className="lablist">
        {props.rows.map((r) => {
          const c = r.conn;
          return (
            <li
              key={c.id}
              className="labrow"
              onClick={(e) => {
                if (isRowClick(e, "button, .ov")) props.onOpen(c);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                props.setMenuFor(c.id);
              }}
            >
              <span className="labrow__icon" aria-hidden>
                <ConnIcon name={c.icon} size={16} />
              </span>
              <span className="labrow__name">{rowLabel(c)}</span>
              {r.failed ? (
                <span className="labrow__pill labrow__pill--danger">Can’t connect</span>
              ) : r.heldOpen ? (
                <span className="labrow__pill labrow__pill--open">Already open</span>
              ) : null}
              <span className="labrow__actions">
                {r.updateHint ? <span className="labrow__hint">Update available</span> : null}
                <button type="button" className="btn labrow__open" onClick={() => props.onOpen(c)}>
                  Open
                </button>
                <OverflowMenu
                  items={r.menuItems}
                  contextSub={r.versionLines}
                  open={props.menuFor === c.id}
                  onOpenChange={(o) => props.setMenuFor(o ? c.id : null)}
                />
              </span>
            </li>
          );
        })}
      </ul>
      {props.local}
    </div>
  );
}
