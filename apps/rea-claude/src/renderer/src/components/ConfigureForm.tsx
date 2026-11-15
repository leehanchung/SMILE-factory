import { ChevronDown, ChevronLeft, WarningAltFilled } from "@carbon/icons-react";
import { useEffect, useState } from "react";
import type { ConnectionUpsert, HostKeyScanResult, SshHostEntry, TestResult } from "@shared/ipc";
import {
  EMPTY_NEW_HOST,
  HOST_SEARCH_THRESHOLD,
  canSave as computeCanSave,
  filterHosts,
  hostOptions,
  newHostInput,
  primaryAction,
  primaryLabel,
  savedName,
  sshTestTarget,
} from "../lib/form";
import type { HostMode, NewHostFields } from "../lib/form";
import { CONN_ICON_KEYS } from "../lib/icons";
import { isLocal, isManaged } from "../lib/visibility";
import { ConnIcon } from "./ConnIcon";
import { ACCEPT_FAILED, HostKeyFingerprint } from "./HostKeyPanel";

/**
 * Add (wizard) / edit a Lab [renderer §4.12, §6]. Deviation X3: when the SSH
 * test reports an unknown host key, the form scans and shows the fingerprint
 * first, and "Accept host key & add" trusts only that fingerprint.
 */
export function ConfigureForm(props: {
  initial: ConnectionUpsert;
  /** Present => wizard mode. */
  onBack?: () => void;
  onCancel: () => void;
  onSave: (draft: ConnectionUpsert) => Promise<unknown> | void;
}) {
  const { initial, onBack, onCancel, onSave } = props;
  const isEdit = !!initial.id;
  const isWizard = !!onBack;
  const managed = isManaged(initial);
  const noSsh = managed || isLocal(initial);

  const [form, setForm] = useState<ConnectionUpsert>(initial);
  const [hosts, setHosts] = useState<SshHostEntry[]>([]);
  const [mode, setMode] = useState<HostMode>("pick");
  const [newHost, setNewHostState] = useState<NewHostFields>(EMPTY_NEW_HOST);
  const [error, setError] = useState("");
  const [showIcons, setShowIcons] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsgState] = useState<TestResult | null>(null);
  const [hostQuery, setHostQuery] = useState("");
  const [hkScan, setHkScan] = useState<HostKeyScanResult | null>(null);

  const initialHost = initial.ssh?.host;
  useEffect(() => {
    if (managed) return undefined;
    let stale = false;
    window.silico.ssh
      .listHosts()
      .then((hs) => {
        if (stale) return;
        setHosts(hs);
        if (hs.length === 0 && !initialHost) setMode("new");
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [initialHost, managed]);

  const pickedHost = form.ssh?.host;
  const target = (): ReturnType<typeof sshTestTarget> => sshTestTarget(mode, pickedHost, newHost);

  const setTestMsg = (r: TestResult | null): void => {
    setTestMsgState(r);
    setHkScan(null);
  };

  // X3: scan the host key as soon as the test says it is unknown.
  const needsKey = !!testMsg && !testMsg.ok && testMsg.hostKey === "unknown";
  useEffect(() => {
    if (!needsKey) return undefined;
    let stale = false;
    window.silico.lab.hostKey
      .scan(sshTestTarget(mode, pickedHost, newHost))
      .then((r) => {
        if (!stale) setHkScan(r);
      })
      .catch((e: unknown) => {
        if (!stale) setHkScan({ ok: false, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      stale = true;
    };
    // Scan once per unknown-key test result.
  }, [needsKey, testMsg]);

  const set = (patch: Partial<ConnectionUpsert>): void => setForm((f) => ({ ...f, ...patch }));
  const setNew = (patch: Partial<NewHostFields>): void => {
    setNewHostState((h) => ({ ...h, ...patch }));
    setTestMsg(null);
  };

  const handleSave = async (): Promise<void> => {
    setError("");
    try {
      if (noSsh) {
        await onSave({ ...form, ssh: undefined, name: savedName(form, true) });
        return;
      }
      let ssh = form.ssh;
      if (mode === "new") {
        const input = newHostInput(form.deploymentId, newHost);
        await window.silico.ssh.addHost(input);
        ssh = { host: input.alias };
      }
      await onSave({ ...form, ssh, name: savedName(form, false, ssh?.host) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const testAndSave = async (): Promise<void> => {
    setError("");
    setTestMsg(null);
    setTesting(true);
    try {
      const r = await window.silico.lab.test(target());
      setTestMsg(r);
      if (r.ok) await handleSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const acceptKeyAndSave = async (): Promise<void> => {
    if (!hkScan?.ok) return;
    setError("");
    setTesting(true);
    try {
      const accepted = await window.silico.lab.hostKey.accept(target(), hkScan.fingerprint);
      if (!accepted.ok) {
        setTestMsg({ ok: false, detail: accepted.error || ACCEPT_FAILED });
        return;
      }
      const r = await window.silico.lab.test(target());
      setTestMsg(r);
      if (r.ok) await handleSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const options = hostOptions(hosts, pickedHost);
  const searchable = options.length > HOST_SEARCH_THRESHOLD;
  const shown = filterHosts(options, hostQuery);
  const canSave = computeCanSave({ noSsh, mode, pickedHost, newHostName: newHost.hostName });
  const action = primaryAction({ isEdit, managed, test: testMsg });
  const acceptBlocked = action === "accept-and-save" && !hkScan?.ok;

  const onPrimary = (): void => {
    if (action === "save") void handleSave();
    else if (action === "accept-and-save") void acceptKeyAndSave();
    else void testAndSave();
  };

  return (
    <div className="pane__inner labs">
      <div className="backbar">
        <button type="button" className="backlink" onClick={isWizard ? onBack : onCancel}>
          <ChevronLeft size={16} aria-hidden />
          {isWizard ? "Connect an existing lab" : "Labs"}
        </button>
      </div>
      <div className="labs__head">
        <h1 className="pane__h1">{isEdit ? "Edit lab" : "Add a lab"}</h1>
      </div>
      <div className="form">
        <div className="field">
          <span className="label">Name &amp; icon</span>
          <div className="nameicon">
            <div className="iconpick">
              <button
                type="button"
                className="iconpick__btn"
                aria-label="Pick an icon"
                aria-expanded={showIcons}
                onClick={() => setShowIcons((s) => !s)}
              >
                <ConnIcon name={form.icon} size={18} />
                <ChevronDown size={11} className="iconpick__car" aria-hidden />
              </button>
              {showIcons ? (
                <>
                  <div className="ov__backdrop" onClick={() => setShowIcons(false)} />
                  <div className="icon-grid" role="menu">
                    {CONN_ICON_KEYS.map((key) => (
                      <button
                        key={key}
                        type="button"
                        role="menuitemradio"
                        aria-checked={form.icon === key}
                        aria-label={key}
                        className={`icon-btn${form.icon === key ? " icon-btn--active" : ""}`}
                        onClick={() => {
                          set({ icon: key });
                          setShowIcons(false);
                        }}
                      >
                        <ConnIcon name={key} size={18} />
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
            <input
              className="nameicon__name"
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Name this Lab"
            />
          </div>
        </div>

        {noSsh ? null : (
          <div className="field">
            <span className="label">Which SSH host reaches {form.deploymentId || "this cluster"}?</span>
            {searchable ? (
              <input
                className="hostpick__search"
                type="search"
                value={hostQuery}
                onChange={(e) => setHostQuery(e.target.value)}
                placeholder="Search hosts"
                aria-label="Search SSH hosts"
              />
            ) : null}
            <div role="radiogroup" aria-label="SSH host">
              {options.length > 0 ? (
                <ul className="hostpick">
                  {shown.length === 0 ? (
                    <li className="hostpick__none">No hosts match “{hostQuery.trim()}”.</li>
                  ) : (
                    shown.map((h) => (
                      <li key={h.alias}>
                        <label className="hostpick__opt">
                          <input
                            type="radio"
                            name="sshhost"
                            className="choice__radio"
                            checked={mode === "pick" && form.ssh?.host === h.alias}
                            onChange={() => {
                              setMode("pick");
                              set({ ssh: { ...(form.ssh ?? {}), host: h.alias } });
                              setTestMsg(null);
                            }}
                          />
                          <span className="hostpick__body">
                            <span className="hostpick__alias">{h.alias}</span>
                            {h.hostName ? <span className="hostpick__host">{h.hostName}</span> : null}
                          </span>
                        </label>
                      </li>
                    ))
                  )}
                </ul>
              ) : null}
              <label className="hostpick__opt hostpick__new">
                <input
                  type="radio"
                  name="sshhost"
                  className="choice__radio"
                  checked={mode === "new"}
                  onChange={() => {
                    setMode("new");
                    setTestMsg(null);
                  }}
                />
                <span className="hostpick__body">
                  <span className="hostpick__alias">Set up a new Lab</span>
                  <span className="hostpick__host">I have an SSH key that isn’t in my config yet</span>
                </span>
              </label>
            </div>
            {mode === "new" ? (
              <div className="nest">
                <div className="fld">
                  <span className="lbl">
                    Host<span className="lbl__opt">the cluster’s SSH login node</span>
                  </span>
                  <input
                    aria-label="Host"
                    value={newHost.hostName}
                    onChange={(e) => setNew({ hostName: e.target.value })}
                    placeholder="login.your-cluster.example"
                  />
                </div>
                <div className="row2">
                  <div className="fld">
                    <span className="lbl">Username</span>
                    <input
                      aria-label="Username"
                      value={newHost.user}
                      onChange={(e) => setNew({ user: e.target.value })}
                      placeholder="your cluster user"
                    />
                  </div>
                  <div className="fld fld--port">
                    <span className="lbl">Port</span>
                    <input
                      aria-label="Port"
                      value={newHost.port}
                      onChange={(e) => setNew({ port: e.target.value })}
                      placeholder="22"
                      inputMode="numeric"
                    />
                  </div>
                </div>
                <div className="fld">
                  <span className="lbl">
                    SSH key<span className="lbl__opt">optional, uses your agent if blank</span>
                  </span>
                  <div className="keyrow">
                    <input
                      aria-label="SSH key"
                      value={newHost.identityFile}
                      onChange={(e) => setNew({ identityFile: e.target.value })}
                      placeholder="~/.ssh/id_ed25519"
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        void window.silico
                          .pickSshKey()
                          .then((p) => {
                            if (p) setNew({ identityFile: p });
                          })
                          .catch(() => {});
                      }}
                    >
                      Browse…
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {testMsg && !testMsg.ok ? (
        <div className="test-row">
          <span className={`test-msg test-msg--${testMsg.hostKey === "unknown" ? "warn" : "err"}`}>
            {testMsg.hostKey === "unknown" ? null : <WarningAltFilled size={14} aria-hidden />}
            {testMsg.detail}
          </span>
        </div>
      ) : null}
      {needsKey ? (
        <div className="hk">
          <div className="hk__title">First time connecting to {target().host}</div>
          <HostKeyFingerprint scan={hkScan} />
        </div>
      ) : null}

      <div className="form__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canSave || testing || acceptBlocked}
          onClick={onPrimary}
        >
          {testing ? <span className="spinner" aria-hidden /> : null}
          {primaryLabel({ testing, isEdit, managed, test: testMsg })}
        </button>
        {error ? <span className="hint hint--warn">{error}</span> : null}
      </div>
    </div>
  );
}
