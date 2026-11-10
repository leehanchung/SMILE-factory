/**
 * Page scripts evaluated in Lab / viewer pages via `executeJavaScript`
 * (windows spec §4.1 step 7, §4.9 watchdog, §4.11 step 3). Written from the
 * behavioral description; they only read the DOM.
 */
import { AUTH_WALL_SELECTOR } from "@shared/config";

/** true when the SPA shows its GitHub sign-in wall. */
export const AUTH_WALL_PROBE_SCRIPT = `!!document.querySelector(${JSON.stringify(AUTH_WALL_SELECTOR)})`;

/**
 * Resolves once the SPA is mounted: `html[data-silico-mounted]` is set, or
 * `#root` has children other than a lone `#silico-boot`.
 */
export const MOUNT_WAIT_SCRIPT = `new Promise(function (done) {
  function isMounted() {
    var html = document.documentElement;
    if (html && html.dataset && html.dataset.silicoMounted) return true;
    var root = document.getElementById("root");
    if (!root || root.childElementCount === 0) return false;
    var boot = document.getElementById("silico-boot");
    return !(boot && root.contains(boot) && root.childElementCount === 1);
  }
  if (isMounted()) { done(); return; }
  var mo = new MutationObserver(function () {
    if (isMounted()) { mo.disconnect(); done(); }
  });
  mo.observe(document.documentElement, {
    attributes: true, attributeFilter: ["data-silico-mounted"], childList: true, subtree: true
  });
})`;

/** Watchdog page liveness: "alive" | "dead" | "unknown". */
export const PAGE_LIVENESS_SCRIPT = `(function () {
  try {
    if (document.readyState !== "complete") return "unknown";
    var html = document.documentElement;
    var mounted = !!(html && html.dataset.silicoMounted);
    var root = document.getElementById("root");
    if (!document.body || !root) return mounted ? "alive" : "unknown";
    if (root.childElementCount === 0) return "dead";
    var boot = document.getElementById("silico-boot");
    if (boot && root.contains(boot) && root.childElementCount === 1) return "dead";
    return "alive";
  } catch (e) { return "unknown"; }
})()`;

/**
 * Viewer "artifact settled": resolves after the artifact read frame loads,
 * a denied/error marker appears, or (two frames later) no artifact page
 * exists. Always resolves after two animation frames from settling.
 */
export const ARTIFACT_SETTLED_SCRIPT = `new Promise(function (done) {
  var settledOnce = false, finished = false, mo = null, frameEl = null;
  function finish() {
    if (finished) return;
    finished = true;
    if (mo) mo.disconnect();
    if (frameEl) frameEl.removeEventListener("load", finish);
    requestAnimationFrame(function () { requestAnimationFrame(function () { done(); }); });
  }
  function check() {
    var page = document.querySelector('[data-testid="artifact-read-page"]');
    if (!page) { if (settledOnce) finish(); return; }
    if (page.querySelector('[data-testid="artifact-read-denied"],[data-testid="artifact-read-error"]')) { finish(); return; }
    var f = page.querySelector('[data-testid="artifact-read-frame"]');
    if (f && f !== frameEl) {
      if (frameEl) frameEl.removeEventListener("load", finish);
      frameEl = f;
      f.addEventListener("load", finish, { once: true });
      try {
        var d = f.contentDocument;
        var blankStart = d && d.location.href === "about:blank" && f.hasAttribute("src");
        if (d && d.readyState === "complete" && !blankStart) finish();
      } catch (e) { /* cross-origin frame: rely on load */ }
    }
  }
  mo = new MutationObserver(check);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  check();
  requestAnimationFrame(function () { requestAnimationFrame(function () { settledOnce = true; check(); }); });
})`;
