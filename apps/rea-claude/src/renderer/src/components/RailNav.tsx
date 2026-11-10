import { Chemistry, Code, Notification, User } from "@carbon/icons-react";
import type { ReactNode } from "react";
import type { SettingsTab } from "@shared/ipc";

/** Settings tab buttons (shared by the App rail and the settings sheet). */
export function SettingsNavItems(props: {
  activeTab: SettingsTab | null;
  developerVisible: boolean;
  onSelect: (tab: SettingsTab) => void;
}) {
  const item = (tab: SettingsTab, label: string, icon: ReactNode) => (
    <button
      key={tab}
      type="button"
      className={`rail__item${props.activeTab === tab ? " rail__item--active" : ""}`}
      onClick={() => props.onSelect(tab)}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <>
      {item("notifications", "Notifications", <Notification size={14} aria-hidden />)}
      {props.developerVisible ? item("developer", "Developer settings", <Code size={14} aria-hidden />) : null}
      {item("profile", "Profile", <User size={14} aria-hidden />)}
    </>
  );
}

export function LabsNavItem({ active, onSelect }: { active: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`rail__item${active ? " rail__item--active" : ""}`} onClick={onSelect}>
      <Chemistry size={14} aria-hidden />
      Labs
    </button>
  );
}
