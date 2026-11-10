import { describe, expect, it } from "vitest";
import {
  cascadePosition,
  centerClamp,
  chromeFor,
  compactContentHeight,
  compactResizeBounds,
  frameHeight,
  isValidSavedBounds,
  labViewBounds,
  normalSizeAfterCompact,
  parseSavedBounds,
  scaleByZoom,
  settingsSheetBounds,
  sizeLikeParent,
} from "../../../src/main/windows/geometry";
import {
  decideFrameNavigation,
  decideLabNavigation,
  gatewayOf,
  isAllowedLabRoute,
  isAuthWall,
  isGatewayRoot,
  isLabishUrl,
  isRevealablePath,
  labReturnTo,
  pageLabel,
  parseRecoveryTarget,
  recoveryRoute,
  sameOrigin,
  viewerNeedsLabBridge,
} from "../../../src/main/windows/navPolicy";
import {
  classifyHealthStatus,
  entryNeedsReplace,
  isLongSuspend,
  isReloadableVis,
  labStateFor,
  normalizePageProbe,
  sheetTabFor,
  shouldRevive,
  shouldShedMemory,
  watchdogPresence,
  windowHoldsLab,
} from "../../../src/main/windows/rules";

const WA = { x: 0, y: 0, width: 1440, height: 900 };

describe("geometry", () => {
  it("compactContentHeight (spec §8)", () => {
    expect(compactContentHeight(undefined, 1000)).toBe(680);
    expect(compactContentHeight(Number.NaN, 1000)).toBe(680);
    expect(compactContentHeight(300, 1000)).toBe(500);
    expect(compactContentHeight(700.2, 1000)).toBe(701);
    expect(compactContentHeight(2000, 1000)).toBe(880);
    expect(compactContentHeight(2000, 600)).toBe(560);
    expect(compactContentHeight(2000, 400)).toBe(500);
  });

  it("centerClamp", () => {
    expect(centerClamp({ x: 0, y: 0, width: 1280, height: 840 }, 620, 600, WA)).toEqual({
      x: 330,
      y: 120,
      width: 620,
      height: 600,
    });
    expect(centerClamp({ x: 1300, y: 0, width: 400, height: 400 }, 620, 600, { x: 0, y: 25, width: 1440, height: 875 })).toEqual({
      x: 820,
      y: 25,
      width: 620,
      height: 600,
    });
    // lo wins when the window is larger than the work area
    expect(centerClamp({ x: 0, y: 0, width: 100, height: 100 }, 2000, 100, WA).x).toBe(0);
  });

  it("cascadePosition", () => {
    expect(cascadePosition({ x: 100, y: 10 }, WA, 1280, 840)).toEqual({ x: 128, y: 38 });
    expect(cascadePosition(null, WA)).toBeUndefined();
    expect(cascadePosition({ x: 200, y: 100 }, WA, 1280, 840)).toEqual({ x: 40, y: 40 });
  });

  it("sizeLikeParent enforces minimums and cascades", () => {
    const o = sizeLikeParent({ x: 10, y: 10, width: 600, height: 400 }, WA);
    expect(o).toMatchObject({ width: 823, height: 540, minWidth: 823, minHeight: 540, x: 38, y: 38, autoHideMenuBar: true });
    expect(o.title).toBe("Rea Claude");
  });

  it("frame/zoom/layout helpers", () => {
    expect(frameHeight(840, 812, 600)).toBe(628);
    expect(scaleByZoom(32, 1.25)).toBe(40);
    expect(scaleByZoom(32, 0)).toBe(32);
    expect(scaleByZoom(32, Number.NaN)).toBe(32);
    expect(labViewBounds([1280, 800], 1.25)).toEqual({ x: 0, y: 40, width: 1280, height: 760 });
    expect(labViewBounds([100, 20], 1)).toEqual({ x: 0, y: 32, width: 100, height: 0 });
  });

  it("compactResizeBounds pulls y up to keep the bottom on screen", () => {
    expect(compactResizeBounds({ x: 5, y: 500, width: 620, height: 600 }, 700, WA)).toEqual({ x: 5, y: 200, width: 620, height: 700 });
    expect(compactResizeBounds({ x: 5, y: 50, width: 620, height: 600 }, 700, WA).y).toBe(50);
  });

  it("normalSizeAfterCompact", () => {
    expect(normalSizeAfterCompact(undefined)).toEqual({ width: 1280, height: 840 });
    expect(normalSizeAfterCompact({ x: 0, y: 0, width: 900, height: 600 })).toEqual({ width: 900, height: 600 });
    expect(normalSizeAfterCompact({ x: 0, y: 0, width: 620, height: 500 })).toEqual({ width: 1280, height: 840 });
  });

  it("isValidSavedBounds / parseSavedBounds", () => {
    expect(isValidSavedBounds({ x: 0, y: 0, width: 100, height: 100 }, [WA])).toBe(true);
    expect(isValidSavedBounds({ x: 5000, y: 0, width: 100, height: 100 }, [WA])).toBe(false);
    expect(isValidSavedBounds({ x: 0, y: 0, width: 0, height: 100 }, [WA])).toBe(false);
    expect(isValidSavedBounds({ x: 1440, y: 0, width: 100, height: 100 }, [WA])).toBe(false); // touching is not overlap
    expect(isValidSavedBounds({ x: "0", y: 0, width: 10, height: 10 }, [WA])).toBe(false);
    expect(parseSavedBounds('{"x":1,"y":2,"width":3,"height":4,"extra":1}', [WA])).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(parseSavedBounds("not json", [WA])).toBeUndefined();
  });

  it("settingsSheetBounds", () => {
    expect(settingsSheetBounds({ x: 0, y: 0, width: 1280, height: 840 })).toEqual({ x: 240, y: 80, width: 800, height: 600 });
    expect(settingsSheetBounds({ x: 10, y: 10, width: 700, height: 500 })).toEqual({ x: 22, y: 38, width: 676, height: 476 });
  });

  it("chromeFor", () => {
    expect(chromeFor("darwin")).toEqual({ titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 10 } });
    expect(chromeFor("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#ffffff", symbolColor: "#1d272a", height: 32 },
    });
    expect(chromeFor("linux")).toEqual({});
  });
});

describe("navPolicy", () => {
  const ctx = { reauthing: false, fromNavigation: true, shown: true, labOrigin: "https://lab.x" };

  it("decideLabNavigation (spec §8)", () => {
    expect(decideLabNavigation("https://lab.x/api/doc.pdf", "https://lab.x/home", ctx)).toBe("open-document");
    expect(decideLabNavigation("https://my.silico.run/login", "https://lab.x/", ctx)).toBe("auth-wall-reauth");
    expect(decideLabNavigation("https://my.silico.run/login", "https://lab.x/", { ...ctx, shown: false })).toBe(
      "auth-wall-neutralize",
    );
    expect(decideLabNavigation("https://github.com/x", "https://lab.x/", ctx)).toBe("browser");
    expect(decideLabNavigation("https://my.silico.run/oauth", "https://lab.x/", { ...ctx, fromNavigation: false })).toBe(
      "in-app",
    );
    expect(decideLabNavigation("https://anything", "https://lab.x/", { ...ctx, reauthing: true })).toBe("freeze");
  });

  it("decideLabNavigation edge cases", () => {
    expect(decideLabNavigation("https://lab.x/workspace", "https://lab.x/", ctx)).toBe("in-app");
    expect(decideLabNavigation("mailto:a@b", "https://lab.x/", ctx)).toBe("in-app");
    // redirect to unrelated origin escapes to browser; to the lab origin stays
    expect(decideLabNavigation("https://evil.x/", "https://lab.x/", { ...ctx, fromNavigation: false })).toBe("browser");
    expect(decideLabNavigation("https://lab.x/a", "https://my.silico.run/x", { ...ctx, fromNavigation: false })).toBe("in-app");
    // api path on redirect is not a document
    expect(decideLabNavigation("https://lab.x/api/x", "https://lab.x/", { ...ctx, fromNavigation: false })).toBe("in-app");
    // aliases count as gateways
    expect(isAuthWall("https://silico.goodfire.com/login/x")).toBe(true);
    expect(isAuthWall("https://my.silico.run/loginx")).toBe(false);
    expect(isAuthWall("garbage")).toBe(false);
  });

  it("decideFrameNavigation", () => {
    expect(decideFrameNavigation("about:srcdoc", "https://a.x/", "https://lab.x/")).toBe("block-external");
    expect(decideFrameNavigation("https://f.x/", "https://lab.x/p", "https://lab.x/")).toBe("allow");
    expect(decideFrameNavigation("https://f.x/", "https://f.x/2", "https://lab.x/")).toBe("allow");
    expect(decideFrameNavigation("https://f.x/", "https://g.x/", "https://lab.x/")).toBe("block-external");
    expect(decideFrameNavigation("about:srcdoc", "data:text/html,x", "https://lab.x/")).toBe("allow");
  });

  it("isRevealablePath", () => {
    expect(isRevealablePath("https://lab.x/auth/callback")).toBe(false);
    expect(isRevealablePath("https://lab.x/?return_to=/a")).toBe(false);
    expect(isRevealablePath("https://lab.x/artifacts/abc")).toBe(false);
    expect(isRevealablePath("https://lab.x/artifacts/abc/")).toBe(false);
    expect(isRevealablePath("https://lab.x/reports/r1")).toBe(false);
    expect(isRevealablePath("https://lab.x/artifacts/abc/read")).toBe(true);
    expect(isRevealablePath("https://lab.x/")).toBe(true);
    expect(isRevealablePath("not a url")).toBe(true);
  });

  it("labReturnTo", () => {
    expect(labReturnTo("https://lab.x/")).toBeNull();
    expect(labReturnTo("https://lab.x/auth/callback?x")).toBeNull();
    expect(labReturnTo("https://lab.x/workspace/1?tab=a#h")).toBe("/workspace/1?tab=a#h");
    expect(labReturnTo("about:blank")).toBeNull();
  });

  it("isAllowedLabRoute / recoveryRoute", () => {
    expect(isAllowedLabRoute("/")).toBe(true);
    expect(isAllowedLabRoute("/workspace/abc/x/y")).toBe(true);
    expect(isAllowedLabRoute("/s/th_1/thread/2")).toBe(true);
    expect(isAllowedLabRoute("/s/xx_1")).toBe(false);
    expect(isAllowedLabRoute("/admin")).toBe(false);
    expect(isAllowedLabRoute("/Home/")).toBe(true);
    expect(isAllowedLabRoute("https://lab.x/artifacts/a/read")).toBe(true);
    expect(recoveryRoute("/workspace/1?x=1")).toBe("/workspace/1?x=1");
    expect(recoveryRoute("/auth/callback")).toBeNull();
    expect(recoveryRoute("/admin")).toBeNull();
  });

  it("gateway helpers", () => {
    expect(gatewayOf("https://silico-staging.goodfire.com/x")).toBe("https://my-staging.silico.run");
    expect(gatewayOf("https://lab.silico.run")).toBeNull();
    expect(isGatewayRoot("https://my.silico.run/")).toBe(true);
    expect(isGatewayRoot("https://my.silico.run/login")).toBe(false);
    expect(sameOrigin("https://a.x/1", "https://a.x/2")).toBe(true);
    expect(sameOrigin("bad", "https://a.x/2")).toBe(false);
    expect(pageLabel("https://a.x/p?q#h")).toBe("https://a.x/p");
    expect(pageLabel("file:///x")).toBe("");
  });

  it("isLabishUrl / viewerNeedsLabBridge", () => {
    expect(isLabishUrl("https://abc.silico.run/x")).toBe(true);
    expect(isLabishUrl("http://localhost:3000/")).toBe(true);
    expect(isLabishUrl("http://abc.silico.run/")).toBe(false);
    expect(isLabishUrl("https://u:p@abc.silico.run/")).toBe(false);
    expect(viewerNeedsLabBridge("https://abc.silico.run/workspace/1")).toBe(true);
    expect(viewerNeedsLabBridge("https://abc.silico.run/admin")).toBe(false);
    expect(viewerNeedsLabBridge("https://my.silico.run/share?x")).toBe(true);
    expect(viewerNeedsLabBridge("https://example.com/workspace")).toBe(false);
  });

  it("parseRecoveryTarget", () => {
    expect(parseRecoveryTarget("https://abc.silico.run/workspace/1?q=2")).toEqual({
      originalUrl: "https://abc.silico.run/workspace/1?q=2",
      route: "/workspace/1?q=2",
    });
    expect(parseRecoveryTarget("https://my.silico.run/x?return_to=/s/th_1&deployment=d1")).toEqual({
      originalUrl: "https://my.silico.run/x?return_to=/s/th_1&deployment=d1",
      route: "/s/th_1",
      context: { gatewayUrl: "https://my.silico.run", deployment: "d1" },
    });
    expect(parseRecoveryTarget("https://my.silico.run/x?return_to=//evil")).toBeNull();
    expect(parseRecoveryTarget("https://abc.silico.run/admin")).toBeNull();
    expect(parseRecoveryTarget("https://example.com/")).toBeNull();
  });
});

describe("rules", () => {
  const now = 1_000_000;
  it("shouldRevive (spec §8)", () => {
    expect(shouldRevive("clean-exit", [], now)).toBe(false);
    expect(shouldRevive("crashed", [now - 1000, now - 2000], now)).toBe(true);
    expect(shouldRevive("crashed", [now - 1, now - 2, now - 3], now)).toBe(false);
    expect(shouldRevive("crashed", [now - 61000, now - 62000, now - 63000], now)).toBe(true);
  });

  it("labStateFor / isReloadableVis", () => {
    expect(labStateFor("shown", true)).toBe("ready");
    expect(labStateFor("loading", true)).toBe("down");
    expect(labStateFor("hidden", false)).toBe("loading");
    expect(isReloadableVis("hidden")).toBe(false);
    expect(isReloadableVis("loading")).toBe(true);
  });

  it("windowHoldsLab", () => {
    expect(windowHoldsLab(undefined, false)).toBe(false);
    expect(windowHoldsLab(undefined, true)).toBe(true);
    expect(windowHoldsLab({ vis: "loading", reauthing: false, userLeft: false }, false)).toBe(true);
    expect(windowHoldsLab({ vis: "hidden", reauthing: true, userLeft: false }, false)).toBe(true);
    expect(windowHoldsLab({ vis: "hidden", reauthing: true, userLeft: true }, false)).toBe(false);
    expect(windowHoldsLab({ vis: "hidden", reauthing: false, userLeft: false }, false)).toBe(false);
  });

  it("misc predicates", () => {
    expect(entryNeedsReplace(undefined, "a")).toBe(false);
    expect(entryNeedsReplace({ connId: "a", destroyed: false }, "a")).toBe(false);
    expect(entryNeedsReplace({ connId: "a", destroyed: true }, "a")).toBe(true);
    expect(entryNeedsReplace({ connId: "b", destroyed: false }, "a")).toBe(true);
    expect(isLongSuspend(0, 100_000)).toBe(false);
    expect(isLongSuspend(1, 60_001)).toBe(true);
    expect(isLongSuspend(1, 60_000)).toBe(false);
    expect(shouldShedMemory(14)).toBe(true);
    expect(shouldShedMemory(15)).toBe(false);
    expect(shouldShedMemory(null)).toBe(false);
    expect(watchdogPresence(true, 119)).toBe(true);
    expect(watchdogPresence(true, 120)).toBe(false);
    expect(watchdogPresence(false, 0)).toBe(false);
    expect(classifyHealthStatus(500)).toBe("down");
    expect(classifyHealthStatus(425)).toBe("down");
    expect(classifyHealthStatus(404)).toBe("up");
    expect(normalizePageProbe("dead")).toBe("dead");
    expect(normalizePageProbe(42)).toBe("unknown");
    expect(sheetTabFor("settings:profile")).toBe("profile");
    expect(sheetTabFor("connections")).toBe("notifications");
  });
});
