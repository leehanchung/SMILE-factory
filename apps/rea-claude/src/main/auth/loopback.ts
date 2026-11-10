/**
 * Loopback browser sign-in server (127.0.0.1, random port). [auth §4.1 steps 3-4, §6]
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { GatewayPath, SIGN_IN_TIMEOUT_MS } from "@shared/config";

export const ERR_SIGN_IN_RESTARTED = "Sign-in restarted.";
export const ERR_SIGN_IN_TIMEOUT = "Sign-in timed out. Please try again.";
export const ERR_SIGN_IN_FAILED = "Sign-in failed (state mismatch or missing proof).";

export function buildLoginUrl(origin: string, port: number, state: string): string {
  const redirect = `http://127.0.0.1:${port}/callback?s=${state}`;
  return `${origin}${GatewayPath.login}?mode=desktop&redirect_uri=${encodeURIComponent(redirect)}`;
}

/** DNS-rebinding defence: Host must be exactly `127.0.0.1:<port>`. */
export function isValidHost(host: string | undefined, port: number): boolean {
  return port > 0 && host === `127.0.0.1:${port}`;
}

export interface CallbackResult {
  ok: boolean;
  /** `s` matched the attempt's state (a mismatch is not this attempt's callback). */
  stateOk: boolean;
  proof: string;
  activationCode?: string;
}

/** Parse `/callback?proof=&activation_code=&s=`; ok iff proof non-empty and `s === state`. */
export function parseCallback(requestUrl: string, state: string): CallbackResult {
  let proof = "";
  let activationCode: string | undefined;
  let s: string | null = null;
  try {
    const params = new URL(requestUrl, "http://127.0.0.1").searchParams;
    proof = params.get("proof") ?? "";
    activationCode = params.get("activation_code") || undefined;
    s = params.get("s");
  } catch {
    return { ok: false, stateOk: false, proof: "" };
  }
  const stateOk = s === state;
  return { ok: proof !== "" && stateOk, stateOk, proof, ...(activationCode ? { activationCode } : {}) };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/** Small self-contained result page shown in the browser tab. */
export function resultPage(title: string, heading: string, body: string, iconDataUri = ""): string {
  const icon = iconDataUri
    ? `<img src="${escapeHtml(iconDataUri)}" alt="" style="display:block;height:40px;margin:0 auto 16px" />`
    : "";
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
    `font-family:system-ui,sans-serif;background:#fff;color:#1d272a">` +
    `<main style="max-width:400px;padding:0 20px;text-align:center">${icon}` +
    `<h1 style="font-family:Newsreader,Georgia,serif;font-weight:400;font-size:24px;margin:0 0 8px">${escapeHtml(heading)}</h1>` +
    `<p style="color:#777;font-size:14px;margin:0">${escapeHtml(body)}</p></main></body></html>`
  );
}

export function successPage(iconDataUri = ""): string {
  return resultPage("Signed in", "Signed in", "You can close this tab and return to the app.", iconDataUri);
}

export function failurePage(iconDataUri = ""): string {
  return resultPage("Sign-in failed", "Sign-in didn’t complete", "Return to the app and try again.", iconDataUri);
}

export interface LoopbackOptions {
  /** 16 random bytes hex. */
  state: string;
  /** Called once the server listens; return the login URL origin to open (or open it yourself). */
  onListening: (port: number, isSettled: () => boolean) => void;
  timeoutMs?: number;
  iconDataUri?: string;
}

export interface LoopbackHandle {
  promise: Promise<{ proof: string; activationCode?: string }>;
  /** Reject with "Sign-in restarted." and close the server (no-op once settled). */
  cancel: () => void;
}

/** Start the one-shot callback server. */
export function startLoopback(opts: LoopbackOptions): LoopbackHandle {
  let cancel: () => void = () => {};
  const promise = new Promise<{ proof: string; activationCode?: string }>((resolve, reject) => {
    let settled = false;
    let port = 0;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      fn();
    };
    cancel = () => finish(() => reject(new Error(ERR_SIGN_IN_RESTARTED)));
    const server = createServer((req, res) => {
      if (!isValidHost(req.headers.host, port)) {
        res.writeHead(403).end();
        return;
      }
      const reqUrl = req.url ?? "/";
      let pathname = "";
      try {
        pathname = new URL(reqUrl, "http://127.0.0.1").pathname;
      } catch {
        pathname = "";
      }
      if (pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const result = parseCallback(reqUrl, opts.state);
      if (!result.stateOk) {
        // Deviation X18: a callback with the wrong state is not this attempt's
        // (stale tab, or a local page probing the port): answer 400 and keep
        // waiting instead of aborting the user's real sign-in.
        res.writeHead(400, { "content-type": "text/html; charset=utf-8", connection: "close" });
        res.end(failurePage(opts.iconDataUri));
        return;
      }
      res.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", connection: "close" });
      res.end(result.ok ? successPage(opts.iconDataUri) : failurePage(opts.iconDataUri));
      finish(() =>
        result.ok
          ? resolve({ proof: result.proof, ...(result.activationCode ? { activationCode: result.activationCode } : {}) })
          : reject(new Error(ERR_SIGN_IN_FAILED)),
      );
    });
    const timer = setTimeout(
      () => finish(() => reject(new Error(ERR_SIGN_IN_TIMEOUT))),
      opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
    );
    server.on("error", (err) => finish(() => reject(err)));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      port = addr && typeof addr === "object" ? addr.port : 0;
      opts.onListening(port, () => settled);
    });
  });
  return { promise, cancel: () => cancel() };
}
