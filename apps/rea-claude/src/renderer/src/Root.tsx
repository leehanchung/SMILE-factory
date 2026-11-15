import { rootFromHash } from "./lib/screen";
import { App } from "./screens/App";
import { SettingsModal } from "./screens/SettingsModal";
import { ViewerShell } from "./screens/ViewerShell";

/** Picks the root app for this window by URL hash [renderer §1]. */
export function Root({ hash }: { hash: string }) {
  const root = rootFromHash(hash);
  if (root.kind === "settings-modal") return <SettingsModal initialTab={root.tab} />;
  if (root.kind === "viewer") return <ViewerShell />;
  return <App />;
}

/** `<html data-platform>` drives platform-specific chrome styles. */
export function applyPlatform(doc: Document, platform: string | undefined): void {
  if (platform) doc.documentElement.dataset.platform = platform;
}
