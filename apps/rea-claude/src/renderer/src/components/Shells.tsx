/** Compact picker chrome and full rail shell around the App content [renderer §4.6]. */
import type { ReactNode, Ref } from "react";
import { PRODUCT_NAME } from "@shared/config";
import type { SettingsTab } from "@shared/ipc";
import { Avatar } from "./Avatar";
import { Dragstrip } from "./Dragstrip";
import { Logo } from "./Logo";
import { LabsNavItem, SettingsNavItems } from "./RailNav";
import { RailVersion, UpdateReadyFoot } from "./UpdateFoot";

export function PickerShell(props: {
  login: string;
  staging: boolean;
  inSettings: boolean;
  bodyRef: Ref<HTMLDivElement>;
  onDesktopSettings: () => void;
  children: ReactNode;
}) {
  return (
    <div className="picker">
      <Dragstrip />
      <div className="picker__body" ref={props.bodyRef}>
        {props.children}
      </div>
      <UpdateReadyFoot />
      <div className="picker__foot">
        <Avatar login={props.login} size={18} />
        <span className="picker__login" title={`Signed in as ${props.login}`}>
          {props.login}
        </span>
        {props.staging ? <span className="brand__env">Staging</span> : null}
        {props.inSettings ? null : (
          <button type="button" className="linkaction picker__settings" onClick={props.onDesktopSettings}>
            Desktop settings
          </button>
        )}
      </div>
    </div>
  );
}

export function FullShell(props: {
  login: string;
  staging: boolean;
  labsActive: boolean;
  activeTab: SettingsTab | null;
  developerVisible: boolean;
  bodyRef: Ref<HTMLDivElement>;
  onLabs: () => void;
  onTab: (tab: SettingsTab) => void;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail__top">
          <div className="brand">
            <Logo className="brand__logo" />
            <span className="brand__name">{PRODUCT_NAME}</span>
            {props.staging ? <span className="brand__env">Staging</span> : null}
          </div>
        </div>
        <nav className="rail__nav">
          <LabsNavItem active={props.labsActive} onSelect={props.onLabs} />
          <SettingsNavItems
            activeTab={props.activeTab}
            developerVisible={props.developerVisible}
            onSelect={props.onTab}
          />
        </nav>
        <div className="rail__spacer" />
        <UpdateReadyFoot />
        <div className="rail__acct">
          <div className="rail__acct-row">
            <Avatar login={props.login} size={22} />
            <span className="rail__login" title={`Signed in as ${props.login}`}>
              {props.login}
            </span>
          </div>
          <RailVersion />
        </div>
      </aside>
      <main className="pane">
        <div className="pane__bar" />
        <div className="pane__body" ref={props.bodyRef}>
          {props.children}
        </div>
      </main>
    </div>
  );
}
