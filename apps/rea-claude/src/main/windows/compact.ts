/**
 * Compact (Labs picker) window mode (windows spec §4.6, `oi`).
 * Works on a structural subset of BrowserWindow so it can be tested with fakes.
 */
import { COMPACT_MIN_H, COMPACT_MIN_W, COMPACT_W, WIN_MIN_H, WIN_MIN_W } from "@shared/config";
import {
  centerClamp,
  compactContentHeight,
  compactResizeBounds,
  frameHeight,
  normalSizeAfterCompact,
} from "./geometry";
import type { Rect } from "./geometry";

export interface CompactWindow {
  readonly id: number;
  isDestroyed(): boolean;
  getBounds(): Rect;
  getContentBounds(): Rect;
  getNormalBounds(): Rect;
  setBounds(b: Rect): void;
  setMinimumSize(w: number, h: number): void;
  isFullScreen(): boolean;
  isMaximized(): boolean;
  on(event: "resize", listener: () => void): unknown;
}

export class CompactController {
  /** Presence ⇒ compact; value = normal bounds before entering. */
  private readonly normalBounds = new Map<number, Rect>();
  private readonly recordedHeight = new Map<number, number>();
  private readonly userResized = new Set<number>();
  private readonly resizeHooked = new Set<number>();
  private readonly pendingFirst = new Map<number, () => void>();

  constructor(private readonly workAreaFor: (bounds: Rect) => Rect) {}

  isCompact(winId: number): boolean {
    return this.normalBounds.has(winId);
  }

  /** One-shot callback run after the next `apply` (show gate, §4.8). */
  onNextApply(winId: number, cb: () => void): void {
    this.pendingFirst.set(winId, cb);
  }

  /** Forget everything about a closed window. */
  clear(winId: number): void {
    this.normalBounds.delete(winId);
    this.pendingFirst.delete(winId);
    this.recordedHeight.delete(winId);
    this.userResized.delete(winId);
    this.resizeHooked.delete(winId);
  }

  private record(win: CompactWindow): void {
    this.recordedHeight.set(win.id, win.getBounds().height);
    this.userResized.delete(win.id);
  }

  private hookResize(win: CompactWindow): void {
    if (this.resizeHooked.has(win.id)) return;
    this.resizeHooked.add(win.id);
    win.on("resize", () => {
      if (win.isDestroyed() || !this.normalBounds.has(win.id)) return;
      const h = this.recordedHeight.get(win.id);
      if (h === undefined || win.isFullScreen() || win.isMaximized()) return;
      if (Math.abs(win.getBounds().height - h) > 1) this.userResized.add(win.id);
      else this.userResized.delete(win.id);
    });
  }

  private compactFrameHeight(win: CompactWindow, contentH: number | undefined, wa: Rect): number {
    const b = win.getBounds();
    return frameHeight(b.height, win.getContentBounds().height, compactContentHeight(contentH, wa.height));
  }

  apply(win: CompactWindow | null | undefined, compact: boolean, contentH?: number): void {
    if (!win || win.isDestroyed()) return;
    this.hookResize(win);
    const id = win.id;
    if (compact !== this.normalBounds.has(id)) {
      const bounds = win.getBounds();
      const wa = this.workAreaFor(bounds);
      if (compact) {
        this.normalBounds.set(id, win.getNormalBounds());
        this.userResized.delete(id);
        win.setMinimumSize(COMPACT_MIN_W, COMPACT_MIN_H);
        if (win.isFullScreen()) {
          this.recordedHeight.delete(id);
        } else {
          const h = this.compactFrameHeight(win, contentH, wa);
          const next = centerClamp(bounds, COMPACT_W, h, wa);
          this.recordedHeight.set(id, next.height);
          win.setBounds(next);
          this.record(win);
        }
      } else {
        const stored = this.normalBounds.get(id);
        this.normalBounds.delete(id);
        this.userResized.delete(id);
        this.recordedHeight.delete(id);
        win.setMinimumSize(WIN_MIN_W, WIN_MIN_H);
        const size = normalSizeAfterCompact(stored);
        win.setBounds(centerClamp(bounds, size.width, size.height, wa));
      }
    } else if (compact && contentH !== undefined && !this.userResized.has(id) && !win.isFullScreen() && !win.isMaximized()) {
      const bounds = win.getBounds();
      const wa = this.workAreaFor(bounds);
      const h = this.compactFrameHeight(win, contentH, wa);
      if (Math.abs(h - bounds.height) > 1) {
        this.recordedHeight.set(id, h);
        win.setBounds(compactResizeBounds(bounds, h, wa));
        this.record(win);
      }
    }
    const cb = this.pendingFirst.get(id);
    if (cb) {
      this.pendingFirst.delete(id);
      cb();
    }
  }
}
