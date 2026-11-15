/**
 * Lab bridge module entry (owner: I5).
 *
 * Owns: every `window.silicoDesktop` handler (silico:* channels, incl.
 * recover-session which delegates to ctx.windows.handleRecoverSession and
 * begin/take which delegate to ctx.returns), native notifications (validate,
 * suppress, dedupe, batch, click routing + pending navigate on lab ready),
 * dock/taskbar badge, shell-event queue + nudge, foreground tracker,
 * permission handlers, TLS certificate verify proc.
 */
import type { BridgeService, MainContext, TelemetryService } from "../services";
import type { BridgeDeps } from "./deps";
import { registerBridgeIpcImpl } from "./ipc";
import { createBridgeServiceImpl } from "./service";
import { createTelemetryServiceImpl } from "./telemetry";

export type { BridgeDeps } from "./deps";

export function createTelemetryService(ctx: MainContext, deps?: BridgeDeps): TelemetryService {
  return createTelemetryServiceImpl(ctx, deps);
}

export function createBridgeService(ctx: MainContext, deps?: BridgeDeps): BridgeService {
  return createBridgeServiceImpl(ctx, deps);
}

/** All silico:* lab-page channels (LabInvokeChannel + LabSendChannel). */
export function registerBridgeIpc(ctx: MainContext): void {
  registerBridgeIpcImpl(ctx);
}
