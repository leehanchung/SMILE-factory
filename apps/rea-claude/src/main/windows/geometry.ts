/**
 * Pure window geometry (windows spec §3.1-§3.3, §4.6, §4.8 step 8).
 * No Electron imports: everything here is unit-tested directly.
 */
import {
  CASCADE_OFFSET,
  COMPACT_DEFAULT_H,
  COMPACT_MAX_H,
  COMPACT_MIN_H,
  COMPACT_SCREEN_MARGIN,
  SETTINGS_SHEET_MAX_H,
  SETTINGS_SHEET_MAX_W,
  STRIP_HEIGHT,
  WIN_DEFAULT_H,
  WIN_DEFAULT_W,
  WIN_MIN_H,
  WIN_MIN_W,
  WIN_OVERLAY_COLOR,
  WIN_OVERLAY_SYMBOL,
  WINDOW_TITLE,
} from "@shared/config";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Margin kept between the settings sheet and the parent edges. */
const SHEET_EDGE_MARGIN = 24;
/** Minimum distance between the parent top and the settings sheet. */
const SHEET_MIN_TOP = 28;
/** Fallback cascade position inside the work area when the offset would overflow. */
const CASCADE_FALLBACK_INSET = 40;

/** Compact (picker) content height for a requested height and work-area height (`rr`). */
export function compactContentHeight(h: number | undefined, workH: number): number {
  if (h === undefined || !Number.isFinite(h)) return COMPACT_DEFAULT_H;
  const cap = Math.min(COMPACT_MAX_H, Math.max(COMPACT_MIN_H, workH - COMPACT_SCREEN_MARGIN));
  return Math.ceil(Math.max(COMPACT_MIN_H, Math.min(h, cap)));
}

/** Window frame height for a desired content height (`cr`). */
export function frameHeight(windowHeight: number, contentHeight: number, desiredContent: number): number {
  return desiredContent + (windowHeight - contentHeight);
}

/** clamp where `lo` wins when `hi < lo`, then rounded. */
function clampRound(v: number, lo: number, hi: number): number {
  return Math.round(Math.max(lo, Math.min(v, hi)));
}

/** Re-center a `w`x`h` rect on `old`'s center, clamped into the work area (`ir`). */
export function centerClamp(old: Rect, w: number, h: number, wa: Rect): Rect {
  const cx = old.x + old.width / 2;
  const cy = old.y + old.height / 2;
  return {
    x: clampRound(cx - w / 2, wa.x, wa.x + wa.width - w),
    y: clampRound(cy - h / 2, wa.y, wa.y + wa.height - h),
    width: w,
    height: h,
  };
}

/** New compact height while already compact: keep x/width, pull y up so the bottom fits. */
export function compactResizeBounds(bounds: Rect, newHeight: number, wa: Rect): Rect {
  return {
    x: bounds.x,
    y: Math.min(bounds.y, Math.max(wa.y, wa.y + wa.height - newHeight)),
    width: bounds.width,
    height: newHeight,
  };
}

/** Size restored when leaving compact mode. */
export function normalSizeAfterCompact(stored: Rect | undefined): { width: number; height: number } {
  return {
    width: stored && stored.width >= WIN_MIN_W ? stored.width : WIN_DEFAULT_W,
    height: stored && stored.height >= WIN_MIN_H ? stored.height : WIN_DEFAULT_H,
  };
}

/**
 * Cascade a new window 28 px from the focused window (`ti`). Without a
 * focused window → undefined (OS default placement). Overflowing the work
 * area → work-area origin + 40.
 */
export function cascadePosition(
  focusedPos: Point | null,
  workArea: Rect | null,
  w: number = WIN_DEFAULT_W,
  h: number = WIN_DEFAULT_H,
): Point | undefined {
  if (!focusedPos || !workArea) return undefined;
  let x = focusedPos.x + CASCADE_OFFSET;
  let y = focusedPos.y + CASCADE_OFFSET;
  if (x + w > workArea.x + workArea.width || y + h > workArea.y + workArea.height) {
    x = workArea.x + CASCADE_FALLBACK_INSET;
    y = workArea.y + CASCADE_FALLBACK_INSET;
  }
  return { x, y };
}

export interface SizeLikeParent {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  x?: number;
  y?: number;
  autoHideMenuBar: true;
  title: string;
}

/** Options for a popup/viewer sized like its parent (`ni`). */
export function sizeLikeParent(parentBounds: Rect, workArea: Rect | null): SizeLikeParent {
  const width = Math.max(parentBounds.width, WIN_MIN_W);
  const height = Math.max(parentBounds.height, WIN_MIN_H);
  const pos = cascadePosition({ x: parentBounds.x, y: parentBounds.y }, workArea, width, height);
  return {
    width,
    height,
    minWidth: WIN_MIN_W,
    minHeight: WIN_MIN_H,
    ...(pos ?? {}),
    autoHideMenuBar: true,
    title: WINDOW_TITLE,
  };
}

/** `v * zoom` when zoom is a finite positive number, else `v` (`ko`). */
export function scaleByZoom(v: number, zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? v * zoom : v;
}

/** Bounds of a Lab/viewer view under the 32 px strip, scaled by the host zoom (`ke`). */
export function labViewBounds(contentSize: readonly number[], zoom: number): Rect {
  const width = contentSize[0] ?? 0;
  const height = contentSize[1] ?? 0;
  const top = Math.ceil(scaleByZoom(STRIP_HEIGHT, zoom));
  return { x: 0, y: top, width, height: Math.max(0, height - top) };
}

/** Saved window bounds are usable only if finite, positive and strictly overlapping a work area (`af`). */
export function isValidSavedBounds(r: unknown, workAreas: readonly Rect[]): r is Rect {
  if (!r || typeof r !== "object") return false;
  const b = r as Record<string, unknown>;
  const vals = [b.x, b.y, b.width, b.height];
  if (!vals.every((v) => typeof v === "number" && Number.isFinite(v))) return false;
  const rect = b as unknown as Rect;
  if (rect.width <= 0 || rect.height <= 0) return false;
  return workAreas.some(
    (wa) =>
      rect.x < wa.x + wa.width && rect.x + rect.width > wa.x && rect.y < wa.y + wa.height && rect.y + rect.height > wa.y,
  );
}

/** Parse `window-state.json` text (`cf`). */
export function parseSavedBounds(text: string, workAreas: readonly Rect[]): Rect | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isValidSavedBounds(parsed, workAreas)) return undefined;
    return { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
  } catch {
    return undefined;
  }
}

/** Settings sheet bounds over its parent (§3.3). */
export function settingsSheetBounds(parent: Rect): Rect {
  const width = Math.min(SETTINGS_SHEET_MAX_W, parent.width - SHEET_EDGE_MARGIN);
  const height = Math.min(SETTINGS_SHEET_MAX_H, parent.height - SHEET_EDGE_MARGIN);
  return {
    x: Math.round(parent.x + (parent.width - width) / 2),
    y: Math.round(parent.y + Math.max(SHEET_MIN_TOP, (parent.height - height) / 3)),
    width,
    height,
  };
}

export interface PlatformChrome {
  titleBarStyle?: "hiddenInset" | "hidden";
  trafficLightPosition?: Point;
  titleBarOverlay?: { color: string; symbolColor: string; height: number };
}

/** Platform title-bar options (`Oi`, §3.2). */
export function chromeFor(platform: string): PlatformChrome {
  if (platform === "darwin") return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 10 } };
  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: WIN_OVERLAY_COLOR, symbolColor: WIN_OVERLAY_SYMBOL, height: STRIP_HEIGHT },
    };
  }
  return {};
}
