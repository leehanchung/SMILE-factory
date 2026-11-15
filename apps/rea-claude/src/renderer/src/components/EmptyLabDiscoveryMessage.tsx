import { googleLinkHost } from "../lib/urls";

/** Why discovery found no clusters [renderer §4.11]. */
export function EmptyLabDiscoveryMessage({ sub, gatewayUrl }: { sub: string; gatewayUrl: string }) {
  if (sub.startsWith("google:")) {
    const host = googleLinkHost(gatewayUrl);
    return (
      <p className="labs__sub">
        You signed in with Google, but this Google account isn’t connected to a Silico account yet. Sign in with Google
        at{" "}
        <a href={`https://${host}`} target="_blank" rel="noreferrer">
          {host}
        </a>{" "}
        and follow the instructions there to connect your existing Silico account. Once connected, you can use either
        Google or GitHub to sign in to the app.
      </p>
    );
  }
  return (
    <p className="labs__sub">
      You’re not registered on any Silico clusters yet. If you expected to see one, you may be signed in with the wrong
      account.
    </p>
  );
}
