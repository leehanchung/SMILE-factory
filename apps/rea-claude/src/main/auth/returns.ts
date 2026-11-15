/**
 * Nonce-bound Lab return flows: checkout, MCP OAuth, GitHub connect.
 * [auth §3.6, §4.8; bridge §4.5-4.7]
 */
import type { BrowserWindow, WebContents } from "electron";
import {
  CHECKOUT_NONCE_TTL_MS,
  GITHUB_CONNECT_NONCE_TTL_MS,
  MCP_OAUTH_NONCE_TTL_MS,
  MCP_RETURN_QUEUE_MAX,
  MCP_RETURN_TTL_MS,
} from "@shared/config";
import { LabEventChannel } from "@shared/ipc";
import type { CheckoutOutcome, GithubConnectReturn, McpOauthReturn } from "@shared/ipc";
import { sendLab } from "../ipc/trust";
import type { MainContext, ReturnKind, ReturnsService } from "../services";
import { parseCheckoutReturn, parseGithubConnectReturn, parseMcpOauthReturn } from "./deepLinkParse";
import type { ResolvedAuthDeps } from "./platform";
import { BoundedLifoQueue, NonceStore, PendingByKey, StickySuccessSlot } from "./returnStores";

interface Binding {
  wc: WebContents;
  connId: string | null;
}

export interface ReturnsInternals extends ReturnsService {
  /** Try MCP OAuth, then GitHub connect, then checkout. True when a handler claimed the link. */
  handleDeepLink(url: string): boolean;
}

export function createReturns(ctx: MainContext, deps: ResolvedAuthDeps): ReturnsInternals {
  const nonces: Record<ReturnKind, NonceStore<Binding>> = {
    checkout: new NonceStore<Binding>(CHECKOUT_NONCE_TTL_MS, deps.now),
    "mcp-oauth": new NonceStore<Binding>(MCP_OAUTH_NONCE_TTL_MS, deps.now),
    "github-connect": new NonceStore<Binding>(GITHUB_CONNECT_NONCE_TTL_MS, deps.now),
  };
  const pendingCheckout = new PendingByKey<CheckoutOutcome>();
  const mcpQueue = new BoundedLifoQueue<McpOauthReturn>(MCP_RETURN_QUEUE_MAX, MCP_RETURN_TTL_MS);
  const githubSlot = new StickySuccessSlot<GithubConnectReturn>();

  /** Original sender if alive, else the live Lab view for the connection; window = its host, else the conn's window. */
  const resolveTarget = (b: Binding): { target: WebContents | null; win: BrowserWindow | null } => {
    const target = !b.wc.isDestroyed() ? b.wc : b.connId ? ctx.windows.labWebContentsForConn(b.connId) : null;
    const win = (target ? ctx.windows.findLab(target)?.win : null) ?? (b.connId ? ctx.windows.windowForConn(b.connId) : null);
    return { target, win: win ?? null };
  };

  const alive = (wc: WebContents | null): wc is WebContents => !!wc && !wc.isDestroyed();

  const focusForReturn = (win: BrowserWindow | null, cause: string, connId: string | null): void => {
    if (!win || win.isDestroyed()) return;
    ctx.telemetry.markCause(cause, connId ?? undefined);
    if (win.isMinimized()) win.restore();
    win.show();
    ctx.windows.activateWindow(win, cause);
  };

  const handleMcp = (url: string): boolean => {
    const parsed = parseMcpOauthReturn(url);
    if (!parsed) return false;
    const b = nonces["mcp-oauth"].consume(parsed.nonce);
    if (!b) return true; // stale/unknown nonce: swallowed
    const { target, win } = resolveTarget(b);
    focusForReturn(win, "deep-link:mcp-oauth", b.connId);
    if (b.connId) {
      mcpQueue.push(b.connId, parsed.payload);
      if (alive(target)) {
        ctx.windows.revealIfHidden(target);
        sendLab(target, LabEventChannel.mcpOauthReturn);
      }
    }
    return true;
  };

  const handleGithub = (url: string): boolean => {
    const parsed = parseGithubConnectReturn(url);
    if (!parsed) return false;
    const b = nonces["github-connect"].consume(parsed.nonce);
    if (!b) return true;
    const { target, win } = resolveTarget(b);
    focusForReturn(win, "deep-link:github-connect", b.connId);
    if (b.connId) {
      githubSlot.set(b.connId, parsed.payload);
      if (alive(target)) {
        ctx.windows.revealIfHidden(target);
        sendLab(target, LabEventChannel.githubConnectReturn);
      }
    }
    return true;
  };

  const handleCheckout = (url: string): boolean => {
    const parsed = parseCheckoutReturn(url);
    if (!parsed) return false;
    const b = nonces.checkout.consume(parsed.nonce);
    if (!b) return true;
    const { target, win } = resolveTarget(b);
    if (win && !win.isDestroyed()) {
      ctx.telemetry.markCause("deep-link:checkout", b.connId ?? undefined);
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      deps.focusApp();
    }
    if (alive(target)) {
      ctx.windows.revealIfHidden(target);
      sendLab(target, LabEventChannel.checkoutReturn, parsed.outcome);
    } else if (b.connId) {
      pendingCheckout.set(b.connId, parsed.outcome);
    }
    return true;
  };

  return {
    begin: (kind, sender, connId) => {
      const nonce = deps.randomUUID();
      nonces[kind].add(nonce, { wc: sender, connId });
      return nonce;
    },
    takeMcpOauthReturn: (connId) => (connId ? mcpQueue.take(connId) : null),
    takeGithubConnectReturn: (connId) => (connId ? githubSlot.take(connId) : null),
    install: () => {
      ctx.windows.onLabReady((connId, wc) => {
        const outcome = pendingCheckout.take(connId);
        if (outcome) sendLab(wc, LabEventChannel.checkoutReturn, outcome);
      });
    },
    handleDeepLink: (url) => handleMcp(url) || handleGithub(url) || handleCheckout(url),
  };
}
