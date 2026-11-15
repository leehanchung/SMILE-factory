import { WarningFilled } from "@carbon/icons-react";
import { useEffect, useState } from "react";
import type { HostKeyKind, HostKeyScanResult, SshTarget } from "@shared/ipc";

export const ACCEPT_FAILED = "Could not accept the host key.";

/** Scanned fingerprint block shared by HostKeyPanel and ConfigureForm (X3). */
export function HostKeyFingerprint({ scan }: { scan: HostKeyScanResult | null }) {
  if (!scan) return <p className="hk__body">Fetching the host key…</p>;
  if (!scan.ok) return <p className="hk__err">{scan.error}</p>;
  return (
    <>
      <p className="hk__body">Make sure this matches the cluster’s fingerprint, then accept to trust it:</p>
      <code className="hk__fp">
        {scan.keyType} · {scan.fingerprint}
      </code>
    </>
  );
}

/**
 * SSH host-key trust UI on the Opening screen [renderer §4.20]. Accepting
 * passes the scanned fingerprint so main only trusts that key (D5.2).
 */
export function HostKeyPanel({
  ssh,
  kind,
  onAccepted,
}: {
  ssh: SshTarget;
  kind: HostKeyKind | undefined;
  onAccepted: () => void;
}) {
  const [scan, setScan] = useState<HostKeyScanResult | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (kind !== "unknown") return undefined;
    let stale = false;
    window.silico.lab.hostKey
      .scan(ssh)
      .then((r) => {
        if (!stale) setScan(r);
      })
      .catch((e: unknown) => {
        if (!stale) setScan({ ok: false, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      stale = true;
    };
    // Re-scan only when the target host or kind changes.
  }, [kind, ssh.host]);

  if (kind === "changed") {
    return (
      <div className="hk hk--alarm">
        <div className="hk__title">
          <WarningFilled size={15} aria-hidden />
          Host key changed for {ssh.host}
        </div>
        <p className="hk__body">
          The host key for this server changed since you last trusted it. That can mean the cluster was rebuilt, or
          that the connection is being intercepted. Don’t accept it unless you expected this. If the cluster was
          re-provisioned, remove the old key and reconnect:
        </p>
        <code className="hk__cmd">ssh-keygen -R {ssh.host}</code>
      </div>
    );
  }

  const accept = async (): Promise<void> => {
    if (!scan?.ok) return;
    setAccepting(true);
    setErr("");
    try {
      const r = await window.silico.lab.hostKey.accept(ssh, scan.fingerprint);
      if (r.ok) onAccepted();
      else setErr(r.error || ACCEPT_FAILED);
    } catch (e) {
      setErr(e instanceof Error ? e.message : ACCEPT_FAILED);
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div className="hk">
      <div className="hk__title">First time connecting to {ssh.host}</div>
      <HostKeyFingerprint scan={scan} />
      {scan?.ok ? (
        <>
          {err ? <p className="hk__err">{err}</p> : null}
          <div className="hk__acts">
            <button type="button" className="btn btn--primary" disabled={accepting} onClick={() => void accept()}>
              {accepting ? "Accepting…" : "Accept & connect"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
