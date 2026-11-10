import { ChevronLeft } from "@carbon/icons-react";
import type { Settings, SettingsPatch, SignedInAuthState } from "@shared/ipc";
import { useEscape } from "../hooks/useEscape";
import {
  DEVELOPER_TOGGLES,
  NOTIFICATION_TOGGLES,
  notificationPatch,
  notificationToggleDisabled,
  notificationsOf,
  sectionTitle,
  stagingConfirm,
} from "../lib/settings";
import type { SettingsSection } from "../lib/types";
import { Avatar } from "./Avatar";
import { KeyringNotice } from "./KeyringNotice";
import { ToggleRow } from "./ToggleRow";

/** Settings content: profile, notifications, developer, or all three [renderer §4.13]. */
export function SettingsView(props: {
  auth: SignedInAuthState;
  settings: Settings | null;
  section: SettingsSection;
  developerVisible?: boolean;
  showBack?: boolean;
  onSaveSettings: (patch: SettingsPatch) => Promise<void>;
  onSignOut: () => void;
  onBack: () => void;
}) {
  const { auth, settings, section, onSaveSettings, onSignOut, onBack } = props;
  const developerVisible = props.developerVisible ?? true;
  const all = section === "all";
  const notifications = notificationsOf(settings);
  const staging = settings?.staging ?? false;

  useEscape(onBack);

  const save = (patch: SettingsPatch): void => {
    void onSaveSettings(patch).catch(() => {});
  };

  const toggleStaging = async (): Promise<void> => {
    const next = !staging;
    const ok = await window.silico.confirm(stagingConfirm(next));
    if (!ok) return;
    await onSaveSettings({ staging: next });
    onSignOut();
  };

  const showProfile = section === "profile" || all;
  const showNotifications = section === "notifications" || all;
  const showDeveloper = section === "developer" || (all && developerVisible);

  return (
    <div className="pane__inner sview">
      {props.showBack ? (
        <div className="backbar">
          <button type="button" className="backlink" onClick={onBack}>
            <ChevronLeft size={16} aria-hidden />
            Labs
          </button>
        </div>
      ) : null}
      <h1 className="pane__h1">{sectionTitle(section)}</h1>

      {all ? <h2 className="labs__subhead labs__subhead--first">Profile</h2> : null}
      {showProfile ? (
        <section className="sview__sec">
          <p className="sview__secsub">The GitHub account this app signs in as.</p>
          <div className="settings__item">
            <div className="settings__id">
              <Avatar login={auth.login} size={36} />
              <div>
                <div className="settings__k">{auth.login}</div>
                <div className="settings__kk">@{auth.login}</div>
              </div>
            </div>
            <button type="button" className="btn" onClick={onSignOut}>
              Switch account
            </button>
          </div>
          <KeyringNotice surface="settings" />
        </section>
      ) : null}

      {all ? <h2 className="labs__subhead">Notifications</h2> : null}
      {showNotifications ? (
        <section className="sview__sec">
          {NOTIFICATION_TOGGLES.map((t) => (
            <ToggleRow
              key={t.key}
              label={t.label}
              desc={t.desc}
              on={notifications[t.key]}
              disabled={notificationToggleDisabled(notifications, t.key)}
              onToggle={() => save(notificationPatch(notifications, t.key))}
            />
          ))}
        </section>
      ) : null}

      {all && developerVisible ? <h2 className="labs__subhead">Developer</h2> : null}
      {showDeveloper ? (
        <section className="sview__sec">
          {DEVELOPER_TOGGLES.map((t) => {
            const on = settings?.[t.key] ?? false;
            if (t.key === "staging") {
              return (
                <ToggleRow
                  key={t.key}
                  label={t.label}
                  desc={
                    <>
                      Use <code>silico-dev</code> instead of production. Switching signs you out, then asks you to sign
                      in again.
                    </>
                  }
                  on={on}
                  onToggle={() => {
                    void toggleStaging().catch(() => {});
                  }}
                />
              );
            }
            return (
              <ToggleRow
                key={t.key}
                label={t.label}
                desc={t.desc}
                on={on}
                onToggle={() => save({ [t.key]: !on })}
              />
            );
          })}
        </section>
      ) : null}
    </div>
  );
}
