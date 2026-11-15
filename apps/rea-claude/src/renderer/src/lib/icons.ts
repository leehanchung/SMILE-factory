/** Connection icon keys (order matters for nextUnusedIcon) [renderer §7 icon table]. */

export const CONN_ICON_KEYS = [
  "flask",
  "microscope",
  "testtube",
  "brain",
  "bot",
  "heartbeat",
  "pulse",
  "cpu",
  "sparkle",
  "planet",
  "rocket",
  "star",
  "sun",
  "tree",
  "sprout",
  "bee",
  "mountains",
  "lightning",
  "snowflake",
  "drop",
  "fire",
] as const;

export type ConnIconKey = (typeof CONN_ICON_KEYS)[number];

export const DEFAULT_ICON: ConnIconKey = "flask";

export function isConnIconKey(k: unknown): k is ConnIconKey {
  return typeof k === "string" && (CONN_ICON_KEYS as readonly string[]).includes(k);
}

/** First icon not used by any row; unknown icons count as the default. */
export function nextUnusedIcon(rows: ReadonlyArray<{ icon?: string }>): ConnIconKey {
  const used = new Set<string>(rows.map((r) => (isConnIconKey(r.icon) ? r.icon : DEFAULT_ICON)));
  return CONN_ICON_KEYS.find((k) => !used.has(k)) ?? DEFAULT_ICON;
}
