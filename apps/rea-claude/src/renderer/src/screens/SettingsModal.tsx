import { Close } from "@carbon/icons-react";
import { useEffect, useState } from "react";
import type { SettingsPatch, SettingsTab } from "@shared/ipc";
import { SettingsNavItems } from "../components/RailNav";
import { SettingsView } from "../components/SettingsView";
import { UpdateFooter } from "../components/UpdateFoot";
import { useAuthState, useSettingsState } from "../hooks/useAuthState";
import { parseNavigate, settingsTabFrom } from "../lib/screen";
import { modalDeveloperVisible } from "../lib/visibility";

const closeWindow = (): void => window.close();

/** Separate settings sheet window [renderer §4.17]. */
export function SettingsModal({ initialTab }: { initialTab: string }) {
  const auth = useAuthState();
  const [settings, setSettings] = useSettingsState();
  const [tab, setTab] = useState<SettingsTab>(settingsTabFrom(initialTab));

  useEffect(
    () =>
      window.silico.onNavigate((dest) => {
        const nav = parseNavigate(dest);
        if (nav.view === "settings" && nav.tab) setTab(nav.tab);
      }),
    [],
  );
  useEffect(() => window.silico.auth.onExpired(closeWindow), []);

  if (auth?.status !== "signed-in") return null;

  const save = async (patch: SettingsPatch): Promise<void> => {
    setSettings(await window.silico.settings.set(patch));
  };

  return (
    <div className="smodal">
      <button type="button" className="smodal__close" aria-label="Close" title="Close" onClick={closeWindow}>
        <Close size={18} aria-hidden />
      </button>
      <aside className="smodal__rail">
        <nav className="rail__nav">
          <SettingsNavItems
            activeTab={tab}
            developerVisible={modalDeveloperVisible(auth, settings, tab)}
            onSelect={setTab}
          />
        </nav>
        <div className="rail__spacer" />
        <UpdateFooter />
      </aside>
      <div className="smodal__main">
        <SettingsView
          auth={auth}
          settings={settings}
          section={tab}
          onSaveSettings={save}
          onSignOut={() => {
            void window.silico.auth
              .signOutEverywhere()
              .then(closeWindow)
              .catch(() => {});
          }}
          onBack={closeWindow}
        />
      </div>
    </div>
  );
}
