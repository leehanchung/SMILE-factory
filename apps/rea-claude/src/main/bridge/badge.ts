/**
 * Pure dock/taskbar badge math [bridge §4.3, windows §4.10].
 */
import { BADGE_COUNT_MAX } from "@shared/config";
import type { BadgeCounts } from "@shared/ipc";

/** Finite, non-negative number → floored and capped at 9999; anything else → null. */
export function sanitizeCount(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.min(Math.floor(v), BADGE_COUNT_MAX);
}

/** Whole payload is ignored (null) when either field is invalid. */
export function parseBadge(raw: unknown): BadgeCounts | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const attention = sanitizeCount(r.attention);
  const unread = sanitizeCount(r.unread);
  if (attention === null || unread === null) return null;
  return { attention, unread };
}

export interface BadgeResult {
  text: string;
  count: number;
}

/** Sum over all Labs (the sum itself is not re-capped). */
export function aggregateBadge(
  all: Iterable<BadgeCounts>,
  s: { enabled: boolean; badge: boolean },
): BadgeResult {
  if (!s.enabled || !s.badge) return { text: "", count: 0 };
  let attention = 0;
  let unread = 0;
  for (const c of all) {
    attention += c.attention;
    unread += c.unread;
  }
  if (attention > 0) return { text: String(attention), count: attention };
  if (unread > 0) return { text: "•", count: 0 };
  return { text: "", count: 0 };
}

export type BadgeAction = { kind: "dock"; text: string } | { kind: "count"; count: number } | { kind: "none" };

/** macOS: dock text (incl. "•"); Linux: numeric count only (unread-only shows nothing); Windows/other: nothing. */
export function badgeActionFor(platform: string, r: BadgeResult): BadgeAction {
  if (platform === "darwin") return { kind: "dock", text: r.text };
  if (platform === "linux") return { kind: "count", count: r.count };
  return { kind: "none" };
}
