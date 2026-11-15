import { describe, expect, it, vi } from "vitest";
import {
  createPermissionCheckHandler,
  createPermissionRequestHandler,
  MicGrants,
  sameOrigin,
  type MicDialogOptions,
  type PermissionDeps,
} from "../../../src/main/bridge/permissions";

interface Wc {
  url: string;
  destroyed: boolean;
}
const WIN = { id: 1 };

function setup(opts: { lab?: boolean; eligible?: boolean; response?: number | Error } = {}) {
  const wc: Wc = { url: "https://x.silico.run/home", destroyed: false };
  const state = { eligible: opts.eligible ?? true };
  let resolveDialog: (v: { response: number }) => void = () => {};
  let rejectDialog: (e: unknown) => void = () => {};
  const dialogs: MicDialogOptions[] = [];
  const deps: PermissionDeps<Wc, typeof WIN> = {
    isLabPartition: opts.lab ?? true,
    focusedLabWindowFor: () => (state.eligible ? WIN : null),
    getURL: (w) => w.url,
    isDestroyed: (w) => w.destroyed,
    showDialog: (_win, o) => {
      dialogs.push(o);
      return new Promise((res, rej) => {
        resolveDialog = res;
        rejectDialog = rej;
      });
    },
  };
  const grants = new MicGrants<Wc>();
  const request = createPermissionRequestHandler(deps, grants);
  const check = createPermissionCheckHandler(deps, grants);
  const ask = (permission: string, details: Record<string, unknown> = {}) => {
    const cb = vi.fn<(g: boolean) => void>();
    request(wc, permission, cb, { isMainFrame: true, requestingUrl: wc.url, mediaTypes: ["audio"], ...details });
    return cb;
  };
  return { wc, state, deps, grants, request, check, ask, dialogs, resolve: (r: number) => resolveDialog({ response: r }), reject: (e: unknown) => rejectDialog(e) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("permission request handler", () => {
  it.each([
    ["clipboard-sanitized-write", true],
    ["fullscreen", true],
    ["notifications", false],
    ["geolocation", false],
    ["clipboard-read", false],
    ["openExternal", false],
    ["display-capture", false],
    ["midi", false],
  ])("non-media %s → %s", (perm, expected) => {
    const t = setup();
    expect(t.ask(perm).mock.calls).toEqual([[expected]]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["subframe", { isMainFrame: false }],
    ["video", { mediaTypes: ["video"] }],
    ["audio+video", { mediaTypes: ["audio", "video"] }],
    ["no mediaTypes", { mediaTypes: undefined }],
    ["empty mediaTypes", { mediaTypes: [] }],
  ])("media denied: %s", (_n, details) => {
    const t = setup();
    expect(t.ask("media", details).mock.calls).toEqual([[false]]);
    expect(t.dialogs).toHaveLength(0);
  });

  it("media denied on the signup partition", () => {
    const t = setup({ lab: false });
    expect(t.ask("media").mock.calls).toEqual([[false]]);
  });

  it("media denied when not the focused shown Lab", () => {
    const t = setup({ eligible: false });
    expect(t.ask("media").mock.calls).toEqual([[false]]);
  });

  it("prompts with the exact dialog, grants on Allow and remembers the origin", async () => {
    const t = setup();
    const cb = t.ask("media");
    expect(cb).not.toHaveBeenCalled();
    expect(t.dialogs[0]).toEqual({
      type: "question",
      title: "Microphone access",
      message: "Allow microphone access for dictation?",
      detail: "https://x.silico.run\nAudio is sent to your Lab's transcription service when you finish dictating.",
      buttons: ["Allow microphone", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    // concurrent prompt for the same wc is denied
    expect(t.ask("media").mock.calls).toEqual([[false]]);
    t.resolve(0);
    await flush();
    expect(cb.mock.calls).toEqual([[true]]);
    // remembered: no second prompt
    expect(t.ask("media").mock.calls).toEqual([[true]]);
    expect(t.dialogs).toHaveLength(1);
    // check handler now allows for that origin only
    expect(t.check(t.wc, "media", "https://x.silico.run", { isMainFrame: true, mediaType: "audio" })).toBe(true);
    expect(t.check(t.wc, "media", "https://y.silico.run", { isMainFrame: true, mediaType: "audio" })).toBe(false);
    expect(t.check(t.wc, "media", "https://x.silico.run", { isMainFrame: true, mediaType: "video" })).toBe(false);
    expect(t.check(t.wc, "media", "https://x.silico.run", { isMainFrame: false, mediaType: "audio" })).toBe(false);
    expect(t.check(null, "media", "https://x.silico.run", { isMainFrame: true, mediaType: "audio" })).toBe(false);
    // origin change re-prompts
    t.wc.url = "https://z.silico.run/";
    t.ask("media");
    expect(t.dialogs).toHaveLength(2);
  });

  it("denies on Cancel", async () => {
    const t = setup();
    const cb = t.ask("media");
    t.resolve(1);
    await flush();
    expect(cb.mock.calls).toEqual([[false]]);
    expect(t.check(t.wc, "media", "https://x.silico.run", { isMainFrame: true, mediaType: "audio" })).toBe(false);
  });

  it("denies when the URL changed during the prompt", async () => {
    const t = setup();
    const cb = t.ask("media");
    t.wc.url = "https://x.silico.run/other";
    t.resolve(0);
    await flush();
    expect(cb.mock.calls).toEqual([[false]]);
  });

  it("denies when the wc was destroyed or is no longer eligible", async () => {
    const a = setup();
    const cbA = a.ask("media");
    a.wc.destroyed = true;
    a.resolve(0);
    await flush();
    expect(cbA.mock.calls).toEqual([[false]]);

    const b = setup();
    const cbB = b.ask("media");
    b.state.eligible = false;
    b.resolve(0);
    await flush();
    expect(cbB.mock.calls).toEqual([[false]]);
  });

  it("denies on dialog error and allows a later prompt", async () => {
    const t = setup();
    const cb = t.ask("media");
    t.reject(new Error("x"));
    await flush();
    expect(cb.mock.calls).toEqual([[false]]);
    t.ask("media");
    expect(t.dialogs).toHaveLength(2);
  });
});

describe("permission check handler", () => {
  it("non-media uses the allowlist", () => {
    const t = setup();
    expect(t.check(t.wc, "fullscreen", "https://x.silico.run", { isMainFrame: true })).toBe(true);
    expect(t.check(t.wc, "notifications", "https://x.silico.run", { isMainFrame: true })).toBe(false);
  });
  it("media false on signup partition even if remembered", () => {
    const t = setup({ lab: false });
    t.grants.granted.set(t.wc, "https://x.silico.run");
    expect(t.check(t.wc, "media", "https://x.silico.run", { isMainFrame: true, mediaType: "audio" })).toBe(false);
  });
  it("media false when not eligible even if remembered", () => {
    const t = setup({ eligible: false });
    t.grants.granted.set(t.wc, "https://x.silico.run");
    expect(t.check(t.wc, "media", "https://x.silico.run", { isMainFrame: true, mediaType: "audio" })).toBe(false);
  });
});

describe("sameOrigin", () => {
  it("compares URL origins", () => {
    expect(sameOrigin("https://a.silico.run/x?y", "https://a.silico.run")).toBe(true);
    expect(sameOrigin("https://a.silico.run:444/", "https://a.silico.run")).toBe(false);
    expect(sameOrigin("http://localhost:3000/a", "http://localhost:3000/b")).toBe(true);
    expect(sameOrigin(undefined, "https://a.silico.run")).toBe(false);
    expect(sameOrigin("garbage", "https://a.silico.run")).toBe(false);
  });
});
