/**
 * Main connection-manager window [renderer §3, §4]. All window state lives
 * here; decisions are delegated to pure functions in ../lib.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  AuthState,
  Connection,
  ConnectionUpsert,
  DiscoveredLab,
  LabConnectOptions,
  LocalStack,
  NavState,
  SettingsPatch,
  SettingsTab,
} from "@shared/ipc";
import { AddWizard } from "../components/AddWizard";
import { ConfigureForm } from "../components/ConfigureForm";
import { Dragstrip } from "../components/Dragstrip";
import { LabActionsMenu, LabsEmpty, LabsList, LocalStacksSection } from "../components/LabsPane";
import type { RowModel } from "../components/LabsPane";
import { LabStatePanel } from "../components/LabStatePanel";
import { Logo } from "../components/Logo";
import { SettingsView } from "../components/SettingsView";
import { FullShell, PickerShell } from "../components/Shells";
import { SignIn } from "../components/SignIn";
import { SignupShell } from "../components/SignupShell";
import { TitlebarStrip } from "../components/TitlebarStrip";
import { useSettingsState } from "../hooks/useAuthState";
import { usePolling } from "../hooks/usePolling";
import { decideAutoOpen, lastOpenedRow } from "../lib/autoOpen";
import {
  chooseOpenAction,
  freshConnState,
  isRowFailed,
  isRunningPhase,
  mapConnectOutcome,
  mapOpenResult,
  mapUpdateOutcome,
} from "../lib/connect";
import type { FlowResult } from "../lib/connect";
import {
  CONNECT_FAILED,
  OPEN_FAILED,
  STOP_FAILED,
  UPDATE_FAILED,
  documentTitle,
  errorMessage,
} from "../lib/copy";
import { isLabsPicker, isLandingKnown, parseNavigate, selectContent, selectScreen } from "../lib/screen";
import { isOutOfDate, versionLines } from "../lib/update";
import { labBaseUrl, openReachBudgetMs } from "../lib/urls";
import { isLive, rowMenuEntries } from "../lib/rowMenu";
import { managedRowsToAdd, rowsToClaim, sortConnections, stampForSave } from "../lib/rows";
import type {
  ConnState,
  ConnStateMap,
  DiscoverySource,
  LabCover,
  LabModel,
  Reachability,
  View,
} from "../lib/types";
import {
  developerSettingsVisible as computeDeveloperVisible,
  discoveryIndex,
  discoveryStatus as computeDiscoveryStatus,
  isLocal,
  isManaged,
  isVisibleTo,
} from "../lib/visibility";
import { LabLoadingScreen, LaunchGate, OpeningScreen } from "./Opening";

export const DISCOVERY_POLL_MS = 20_000;
export const REACH_POLL_MS = 20_000;
export const LOCAL_STACKS_POLL_MS = 3_000;
export const LAUNCH_GATE_MAX_MS = 6_000;
export const JUST_ADDED_CLEAR_MS = 1_500;
export const ELAPSED_TICK_MS = 1_000;

const swallow = (): void => {};

export function App() {
  const api = window.silico;

  // ---- data ----
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [localConns, setLocalConns] = useState<Connection[]>([]);
  const [localStacks, setLocalStacks] = useState<LocalStack[]>([]);
  const [isDevBuild, setIsDevBuild] = useState(false);
  const [settings, setSettings] = useSettingsState();
  const [auth, setAuth] = useState<AuthState | undefined>(undefined);
  const [discovered, setDiscovered] = useState<DiscoveredLab[]>([]);
  const [discoveryLoaded, setDiscoveryLoaded] = useState(false);
  const [discoverySource, setDiscoverySource] = useState<DiscoverySource | null>(null);
  const [reach, setReach] = useState<Record<string, Reachability>>({});
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());
  const [heldElsewhere, setHeldElsewhere] = useState<string[]>([]);

  // ---- per-connection progress ----
  const [conn, setConn] = useState<ConnStateMap>({});
  const [logOpen, setLogOpen] = useState<Record<string, boolean>>({});
  const [, setTick] = useState(0);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [labWaking, setLabWaking] = useState<Record<string, boolean>>({});

  // ---- navigation ----
  const [signupOpen, setSignupOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [adding, setAdding] = useState(false);
  const [addPick, setAddPick] = useState<DiscoveredLab | null>(null);
  const [lab, setLab] = useState<LabModel | null>(null);
  const [labCover, setLabCover] = useState<LabCover>({ shown: false });
  const [labNav, setLabNav] = useState<NavState>({ canGoBack: false, canGoForward: false });
  const [view, setView] = useState<View>("labs");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("notifications");
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [pickerPage, setPickerPage] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [isInitialWin, setIsInitialWin] = useState<boolean | null>(null);
  const [launchGate, setLaunchGate] = useState(true);

  const paneRef = useRef<HTMLDivElement>(null);
  const cancelledOpens = useRef(new Set<string>());
  const autoTried = useRef(false);
  const winTouched = useRef(false);
  const authRef = useRef<AuthState | undefined>(undefined);
  const claiming = useRef(false);
  const autoAdding = useRef(false);

  // ---- derived ----
  const signedInAuth = auth?.status === "signed-in" ? auth : undefined;
  const status = computeDiscoveryStatus(auth, discoveryLoaded, discoverySource);
  const verbose = settings?.verbose ?? false;
  const staging = settings?.staging ?? false;
  const skipVersionCheck = settings?.skipVersionCheck ?? false;
  const developerMode = settings?.developerMode ?? false;
  const previewPinned = (settings?.previewBuilds ?? false) && !staging;
  const developerVisible = computeDeveloperVisible(auth, settings);
  const allConns = localConns.length ? [...connections, ...localConns] : connections;
  const byDeployment = discoveryIndex(discovered, status);
  const visible = signedInAuth
    ? connections.filter((c) =>
        isVisibleTo(c, signedInAuth.login, signedInAuth.gatewayUrl, status, byDeployment),
      )
    : [];

  // Latest values for async continuations and callbacks created in earlier renders.
  const latest = useRef({ conn, heldElsewhere, reach, stopped, byDeployment, status });
  latest.current = { conn, heldElsewhere, reach, stopped, byDeployment, status };

  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  // ---- loaders ----
  const reload = useCallback(async () => {
    const list = await window.silico.connections.list();
    setConnections(list);
    setConnectionsLoaded(true);
  }, []);

  const clearDiscovery = (): void => {
    setDiscovered([]);
    setDiscoveryLoaded(false);
    setDiscoverySource(null);
  };

  const refreshDiscovery = useCallback(() => {
    window.silico.labs
      .list()
      .then((r) => {
        setDiscoveryLoaded(true);
        if (r.ok) {
          setDiscovered(r.labs);
          setDiscoverySource({ gatewayUrl: r.gatewayUrl, login: r.login });
        } else if (r.needsAuth) {
          setAuth({ status: "signed-out" });
          setDiscovered([]);
          setDiscoveryLoaded(false);
          setDiscoverySource(null);
        } else {
          setDiscoverySource(null);
        }
      })
      .catch(swallow);
  }, []);

  // ---- mount subscriptions ----
  useEffect(() => {
    void reload().catch(swallow);
  }, [reload]);

  useEffect(() => {
    let stale = false;
    api.auth
      .status()
      .then((s) => {
        if (!stale) setAuth(s);
      })
      .catch(swallow);
    api.isInitialWindow()
      .then((v) => {
        if (!stale) setIsInitialWin(v);
      })
      .catch(swallow);
    api.isDevBuild()
      .then((v) => {
        if (!stale) setIsDevBuild(v);
      })
      .catch(swallow);
    return () => {
      stale = true;
    };
  }, [api]);

  useEffect(() => {
    const offExpired = api.auth.onExpired(() => {
      setAuth({ status: "signed-out" });
      clearDiscovery();
      setLab(null);
      setView("labs");
    });
    const offChanged = api.auth.onChanged((next) => {
      const prev = authRef.current;
      setAuth(next);
      const same =
        prev?.status === "signed-in" &&
        next.status === "signed-in" &&
        prev.login === next.login &&
        prev.gatewayUrl === next.gatewayUrl;
      if (!same) clearDiscovery();
    });
    return () => {
      offExpired();
      offChanged();
    };
  }, [api]);

  useEffect(() => {
    let stale = false;
    api.signup
      .status()
      .then((o) => {
        if (!stale) setSignupOpen(o);
      })
      .catch(swallow);
    const offOpened = api.signup.onOpened(() => setSignupOpen(true));
    const offClosed = api.signup.onClosed(() => setSignupOpen(false));
    return () => {
      stale = true;
      offOpened();
      offClosed();
    };
  }, [api]);

  useEffect(
    () =>
      api.onNavigate((dest) => {
        winTouched.current = true;
        setLaunchGate(false);
        setLab(null);
        setAdding(false);
        setEditing(null);
        setAddPick(null);
        setOpeningId(null);
        setPickerPage(false);
        const nav = parseNavigate(dest);
        if (nav.view === "settings" && nav.tab) setSettingsTab(nav.tab);
        setView(nav.view);
      }),
    [api],
  );

  useEffect(() => {
    const offOutput = api.lab.onOutput(({ id, chunk }) =>
      setConn((m) => {
        const cs = m[id];
        return cs ? { ...m, [id]: { ...cs, log: cs.log + chunk } } : m;
      }),
    );
    const offPhase = api.lab.onPhase(({ id, phase }) => {
      setConn((m) => {
        const cs = m[id];
        if (!cs || !isRunningPhase(cs.phase)) return m;
        return { ...m, [id]: { ...cs, phase } };
      });
      setLabWaking((m) => {
        if (phase === "waking") return m[id] ? m : { ...m, [id]: true };
        return m[id] ? { ...m, [id]: false } : m;
      });
    });
    return () => {
      offOutput();
      offPhase();
    };
  }, [api]);

  useEffect(() => {
    const offOpened = api.labView.onOpened(({ id, title }) => {
      autoTried.current = true;
      winTouched.current = true;
      setLaunchGate(false);
      setLabWaking((m) => (m[id] ? { ...m, [id]: false } : m));
      if (cancelledOpens.current.delete(id)) {
        void api.labView.hide().catch(swallow);
        return;
      }
      setView("labs");
      setLab({ id, title, state: "loading" });
      const a = authRef.current;
      if (a?.status === "signed-in" && !id.startsWith("local:")) {
        api.lastOpened.set(a.login, id).catch(swallow);
      }
    });
    const offState = api.labView.onState(({ id, state, reason }) => {
      setLab((l) => (l && l.id === id ? { ...l, state, reason } : l));
      if (state !== "loading") setLabWaking((m) => (m[id] ? { ...m, [id]: false } : m));
    });
    const offVis = api.labView.onViewVis((v) => setLabCover(v));
    const offNav = api.labView.onNavState(setLabNav);
    return () => {
      offOpened();
      offState();
      offVis();
      offNav();
    };
  }, [api]);

  // ---- session reset ----
  const sessionKey = signedInAuth ? `${signedInAuth.login} ${signedInAuth.gatewayUrl}` : "";
  useEffect(() => {
    setReach({});
    setStopped(new Set());
  }, [sessionKey]);

  // ---- launch gate ----
  useEffect(() => {
    if (isInitialWin === false) setLaunchGate(false);
  }, [isInitialWin]);

  const signedIn = !!signedInAuth;
  useEffect(() => {
    if (signedIn && !autoTried.current && !winTouched.current && isInitialWin !== false) setLaunchGate(true);
    const t = window.setTimeout(() => setLaunchGate(false), LAUNCH_GATE_MAX_MS);
    return () => window.clearTimeout(t);
  }, [signedIn, isInitialWin]);

  // ---- discovery & reachability polling ----
  // Restart (poll immediately) only when the identity changes [§4.15]: a
  // same-identity auth:changed (token refresh) keeps discovery and the cycle.
  usePolling(refreshDiscovery, DISCOVERY_POLL_MS, signedIn, { deps: [sessionKey] });

  useEffect(() => {
    if (status !== "ok") return undefined;
    const targets = discovered.filter((l) => !l.stale && l.host && l.port);
    if (targets.length === 0) return undefined;
    let cancelled = false;
    const probe = (): void => {
      void Promise.all(
        targets.map(async (l) => {
          const s = await window.silico.lab.status(labBaseUrl(l.host ?? "", l.port ?? 0));
          return [l.deploymentId, s === "up" ? "reachable" : "unreachable"] as const;
        }),
      )
        .then((entries) => {
          if (!cancelled) setReach((r) => ({ ...r, ...Object.fromEntries(entries) }));
        })
        .catch(swallow);
    };
    probe();
    const t = window.setInterval(probe, REACH_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [discovered, status]);

  // ---- local dev stacks ----
  const localEnabled = isDevBuild && staging;
  useEffect(() => {
    if (!localEnabled) {
      setLocalStacks([]);
      return undefined;
    }
    let cancelled = false;
    const detect = (): void => {
      window.silico
        .detectLocalStacks()
        .then((found) => {
          if (!cancelled) setLocalStacks(found);
        })
        .catch(swallow);
    };
    detect();
    window.addEventListener("focus", detect);
    const t = window.setInterval(detect, LOCAL_STACKS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      window.removeEventListener("focus", detect);
    };
  }, [localEnabled]);

  // ---- held elsewhere ----
  useEffect(() => {
    if (view !== "labs" || lab) return undefined;
    let live = true;
    const read = (): void => {
      window.silico.labs
        .heldElsewhere()
        .then((ids) => {
          if (live) setHeldElsewhere(ids);
        })
        .catch(swallow);
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [view, lab]);

  // ---- elapsed ticker ----
  const anyRunning = Object.values(conn).some((c) => isRunningPhase(c.phase));
  useEffect(() => {
    if (!anyRunning) return undefined;
    const t = window.setInterval(() => setTick((n) => n + 1), ELAPSED_TICK_MS);
    return () => window.clearInterval(t);
  }, [anyRunning]);

  // ---- touched ----
  useEffect(() => {
    if (view !== "labs" || lab || openingId || adding || editing || menuFor) winTouched.current = true;
  }, [view, lab, openingId, adding, editing, menuFor]);

  // ---- auto-claim legacy rows / auto-add hosted labs ----
  useEffect(() => {
    if (!signedInAuth || !connectionsLoaded || status !== "ok" || claiming.current) return;
    const claims = rowsToClaim(connections, discovered, signedInAuth.login, signedInAuth.gatewayUrl);
    if (claims.length === 0) return;
    claiming.current = true;
    void Promise.all(claims.map((c) => window.silico.connections.upsert(c)))
      .then(() => reload())
      .catch(swallow)
      .finally(() => {
        claiming.current = false;
      });
  }, [signedInAuth, connectionsLoaded, status, discovered, connections, reload]);

  useEffect(() => {
    if (!signedInAuth || !connectionsLoaded || status !== "ok" || autoAdding.current) return;
    const rows = managedRowsToAdd(connections, discovered, signedInAuth.login, signedInAuth.gatewayUrl);
    if (rows.length === 0) return;
    autoAdding.current = true;
    void (async () => {
      for (const row of rows) await window.silico.connections.upsert(row);
      await reload();
    })()
      .catch(swallow)
      .finally(() => {
        autoAdding.current = false;
      });
  }, [signedInAuth, connectionsLoaded, status, discovered, connections, reload]);

  // ---- developer tab fallback ----
  useEffect(() => {
    if (settingsTab === "developer" && settings !== null && auth !== undefined && !developerVisible) {
      setSettingsTab("notifications");
    }
  }, [settingsTab, settings, auth, developerVisible]);

  // ---- opening / justAdded housekeeping ----
  useEffect(() => {
    if (openingId && conn[openingId]?.phase === "done") setOpeningId(null);
  }, [openingId, conn]);

  useEffect(() => {
    if (justAdded) paneRef.current?.scrollTo?.({ top: 0, behavior: "smooth" });
  }, [justAdded]);

  useEffect(() => {
    if (!justAdded || conn[justAdded]?.phase !== "done") return undefined;
    const t = window.setTimeout(() => setJustAdded(null), JUST_ADDED_CLEAR_MS);
    return () => window.clearTimeout(t);
  }, [justAdded, conn]);

  // ---- document title ----
  useEffect(() => {
    const openConn = lab ? allConns.find((c) => c.id === lab.id) : undefined;
    document.title = documentTitle({
      labTitle: lab?.title,
      localLab: !!openConn && isLocal(openConn),
      staging,
    });
  }, [lab, staging, allConns]);

  // =====================================================================
  // Flows [renderer §4.7]
  // =====================================================================

  const patchState = (id: string, patch: Partial<ConnState>): void =>
    setConn((m) => {
      const cs = m[id];
      return cs ? { ...m, [id]: { ...cs, ...patch } } : m;
    });

  const clearPendingLab = (id: string): void =>
    setLab((l) => (l && l.id === id && l.state !== "ready" ? null : l));

  const expand = (id: string): void => setLogOpen((m) => ({ ...m, [id]: true }));

  const isBusy = (id: string): boolean => isRunningPhase(latest.current.conn[id]?.phase);

  const applyFlow = async (c: Connection, r: FlowResult): Promise<void> => {
    patchState(c.id, r.patch);
    if (r.expandLogs) expand(c.id);
    if (r.clearPendingLab) clearPendingLab(c.id);
    if (r.labUrl) {
      await window.silico.connections.upsert({ ...c, labUrl: r.labUrl });
      await reload();
    }
  };

  const failFlow = (c: Connection, e: unknown, fallback: string, clearLab: boolean): void => {
    patchState(c.id, { phase: "error", message: errorMessage(e, fallback) });
    expand(c.id);
    if (clearLab) clearPendingLab(c.id);
  };

  const startState = (id: string, phase: ConnState["phase"]): void =>
    setConn((m) => ({ ...m, [id]: freshConnState(phase, Date.now()) }));

  const connect = async (c: Connection, opts?: LabConnectOptions): Promise<void> => {
    cancelledOpens.current.delete(c.id);
    if (c.deploymentId) {
      setStopped((s) => {
        if (!s.has(c.deploymentId)) return s;
        const n = new Set(s);
        n.delete(c.deploymentId);
        return n;
      });
    }
    startState(c.id, "checking");
    try {
      const outcome = await window.silico.lab.connect(c, verbose, opts);
      await applyFlow(c, mapConnectOutcome(outcome, c.labUrl));
    } catch (e) {
      failFlow(c, e, CONNECT_FAILED, true);
    }
    cancelledOpens.current.delete(c.id);
    refreshDiscovery();
  };

  const openRunning = async (c: Connection): Promise<void> => {
    if (isBusy(c.id)) return;
    cancelledOpens.current.delete(c.id);
    startState(c.id, "opening");
    try {
      const reachable = c.deploymentId ? latest.current.reach[c.deploymentId] : undefined;
      const r = await window.silico.lab.open(c, { reachTimeoutMs: openReachBudgetMs(reachable) });
      await applyFlow(c, mapOpenResult(r, isManaged(c)));
    } catch (e) {
      failFlow(c, e, OPEN_FAILED, false);
    }
    cancelledOpens.current.delete(c.id);
    refreshDiscovery();
  };

  const updateLab = async (c: Connection): Promise<void> => {
    if (isBusy(c.id)) return;
    cancelledOpens.current.delete(c.id);
    startState(c.id, "updating");
    try {
      const outcome = await window.silico.lab.update(c, { preview: previewPinned });
      await applyFlow(c, mapUpdateOutcome(outcome, c.labUrl));
    } catch (e) {
      failFlow(c, e, UPDATE_FAILED, false);
    }
    cancelledOpens.current.delete(c.id);
    refreshDiscovery();
  };

  const stopLab = async (c: Connection): Promise<void> => {
    if (isBusy(c.id)) return;
    startState(c.id, "stopping");
    try {
      await window.silico.lab.down(c);
      if (c.deploymentId) setStopped((s) => new Set(s).add(c.deploymentId));
      patchState(c.id, { phase: "done" });
    } catch (e) {
      failFlow(c, e, STOP_FAILED, false);
    }
    refreshDiscovery();
  };

  const openHere = (c: Connection): void => {
    const L = latest.current;
    const cs = L.conn[c.id];
    if (cs?.phase === "stopping") return;
    setOpeningId(c.id);
    if (cs && (isRunningPhase(cs.phase) || cs.phase === "host-key")) return;
    const disc = L.status === "ok" && c.deploymentId ? L.byDeployment.get(c.deploymentId) : undefined;
    const action = chooseOpenAction({
      outOfDate: isOutOfDate({ skipVersionCheck, managed: isManaged(c), disc, previewPinned, staging }),
      live: isLive(disc, c.deploymentId, L.stopped),
      reachable: c.deploymentId ? L.reach[c.deploymentId] : undefined,
    });
    if (action === "update") void updateLab(c);
    else if (action === "open") void openRunning(c);
    else void connect(c);
  };

  /** Focus the window already holding this Lab, else open it here. */
  const viaHeld = (c: Connection, here: (c: Connection) => void): void => {
    winTouched.current = true;
    if (latest.current.heldElsewhere.includes(c.id)) {
      window.silico.labs
        .focusHeld(c.id)
        .then((focused) => {
          if (focused) return;
          setHeldElsewhere((ids) => ids.filter((id) => id !== c.id));
          here(c);
        })
        .catch(swallow);
      return;
    }
    here(c);
  };

  const openLab = (c: Connection): void => viaHeld(c, openHere);

  const connectLocal = (c: Connection): void =>
    viaHeld(c, (x) => {
      setLocalConns((prev) => [x, ...prev.filter((p) => p.id !== x.id)]);
      setLab({ id: x.id, title: x.name || x.deploymentId, state: "loading" });
      setAdding(false);
      setAddPick(null);
      setOpeningId(x.id);
      void connect(x);
    });

  const cancelOpening = (c: Connection): void => {
    void window.silico.lab.cancel(c.id).catch(swallow);
    cancelledOpens.current.add(c.id);
    setOpeningId(null);
    setConn((m) => {
      const { [c.id]: _dropped, ...rest } = m;
      return rest;
    });
  };

  const remove = async (id: string): Promise<void> => {
    const c = connections.find((x) => x.id === id);
    if (c && isManaged(c) && c.deploymentId) await window.silico.connections.upsert({ ...c, dismissed: true });
    else await window.silico.connections.remove(id);
    await reload();
  };

  const save = async (draft: ConnectionUpsert): Promise<Connection> => {
    const saved = await window.silico.connections.upsert(
      stampForSave(draft, signedInAuth?.login, signedInAuth?.gatewayUrl),
    );
    setEditing(null);
    await reload();
    return saved;
  };

  const saveSettings = async (patch: SettingsPatch): Promise<void> => {
    setSettings(await window.silico.settings.set(patch));
  };

  const signOut = async (): Promise<void> => {
    await window.silico.auth.signOutEverywhere();
    setAuth({ status: "signed-out" });
    clearDiscovery();
    setConn({});
    setLab(null);
  };

  const openCreateLab = (): void => {
    winTouched.current = true;
    setLaunchGate(false);
    window.silico.signup.open().catch(swallow);
  };

  // ---- auto-open on launch [renderer §4.14] ----
  const visibleKey = visible.map((c) => c.id).join("\n");
  useEffect(() => {
    const decision = decideAutoOpen({
      tried: autoTried.current,
      touched: winTouched.current,
      isInitialWin,
      signedIn,
      connectionsLoaded,
      discoveryLoaded,
      discoveryStatus: status,
      discovered,
      visible,
      launchGate,
    });
    if (decision.kind === "wait" || !signedInAuth) return;
    autoTried.current = true;
    const login = signedInAuth.login;
    if (decision.kind === "retire") {
      if (decision.probeLastOpened) window.silico.lastOpened.get(login).catch(swallow);
      if (decision.open) openLab(decision.open);
      setLaunchGate(false);
      if (decision.signup) window.silico.signup.open().catch(swallow);
      return;
    }
    const rows = visible;
    window.silico.lastOpened
      .get(login)
      .then((id) => {
        const row = lastOpenedRow(id, winTouched.current, rows);
        if (row) openLab(row);
      })
      .catch(swallow)
      .finally(() => setLaunchGate(false));
    // `visible` is tracked through visibleKey.
  }, [isInitialWin, signedInAuth, connectionsLoaded, discoveryLoaded, status, connections, discovered, launchGate, visibleKey]);

  // ---- compact picker sizing ----
  const labsPicker = isLabsPicker({
    signedIn,
    signupOpen,
    launchGate,
    lab,
    openingId,
    view,
    adding,
    editing: !!editing,
    pickerPage,
  });
  const landingKnown = isLandingKnown(auth, isInitialWin, launchGate);
  const [contentTick, setContentTick] = useState(0);
  useEffect(() => {
    if (!labsPicker || view !== "labs" || typeof ResizeObserver === "undefined") return undefined;
    const body = paneRef.current;
    const inner = body?.firstElementChild;
    if (!body || !inner) return undefined;
    const ro = new ResizeObserver(() => setContentTick((n) => n + 1));
    ro.observe(inner);
    ro.observe(body);
    return () => ro.disconnect();
  }, [labsPicker, view]);

  useEffect(() => {
    if (!landingKnown) return;
    const body = paneRef.current;
    const inner = body?.firstElementChild;
    let contentHeight: number | undefined;
    if (labsPicker && view === "labs" && body && inner) {
      const pad = getComputedStyle(body);
      contentHeight = Math.ceil(
        inner.getBoundingClientRect().height +
          (parseFloat(pad.paddingTop) || 0) +
          (parseFloat(pad.paddingBottom) || 0) +
          (window.innerHeight - body.getBoundingClientRect().height),
      );
    }
    window.silico.setCompact(labsPicker, contentHeight).catch(swallow);
  }, [landingKnown, labsPicker, view, contentTick, connections.length, localStacks.length, discovered.length]);

  // =====================================================================
  // Render [renderer §3 top-level decision]
  // =====================================================================

  const openingConn = openingId ? allConns.find((x) => x.id === openingId) : undefined;
  const openingCs = openingId ? conn[openingId] : undefined;
  const contentKind = selectContent({
    view,
    lab,
    editing: !!editing,
    adding,
    openingActive: !!openingConn && !!openingCs,
    visibleCount: visible.length,
  });
  const screen = selectScreen({ signupOpen, auth, content: contentKind, launchGate, labCover, lab });

  if (screen === "signup") {
    return (
      <SignupShell
        staging={staging}
        onBack={() => {
          setSignupOpen(false);
          window.silico.signup.close().catch(swallow);
        }}
      />
    );
  }
  if (screen === "auth-loading" || !auth) {
    return (
      <div className="gate">
        <Dragstrip />
        <div className="gate__card gate__card--loading">
          <span className="spinner" />
        </div>
      </div>
    );
  }
  if (screen === "sign-in" || auth.status !== "signed-in") {
    return <SignIn staging={staging} onSignedIn={setAuth} />;
  }
  const me = auth;

  const head = (
    <div className="labs__head">
      <h1 className="pane__h1">Labs</h1>
      <LabActionsMenu
        onOpen={() => {
          winTouched.current = true;
        }}
        onConnectExisting={() => {
          winTouched.current = true;
          setPickerPage(labsPicker);
          setAddPick(null);
          setAdding(true);
        }}
        onCreate={openCreateLab}
      />
    </div>
  );
  const local =
    localEnabled && localStacks.length > 0 ? (
      <LocalStacksSection stacks={localStacks} heldElsewhere={heldElsewhere} onOpen={connectLocal} />
    ) : null;

  const rowModel = (c: Connection): RowModel => {
    const cs = conn[c.id];
    const busy = isRunningPhase(cs?.phase);
    const disc = c.deploymentId ? byDeployment.get(c.deploymentId) : undefined;
    const live = isLive(disc, c.deploymentId, stopped);
    const managed = isManaged(c);
    const outOfDate = !busy && isOutOfDate({ skipVersionCheck, managed, disc, previewPinned, staging });
    const failed = isRowFailed(cs?.phase);
    const handlers: Record<string, () => void> = {
      tunnel: () => {
        setOpeningId(c.id);
        void connect(c, { tunnel: true });
      },
      update: () => {
        setOpeningId(c.id);
        void updateLab(c);
      },
      stop: () => void stopLab(c),
      edit: () => {
        setPickerPage(labsPicker);
        setEditing(c);
      },
      remove: () => void remove(c.id).catch(swallow),
    };
    return {
      conn: c,
      failed,
      heldOpen: heldElsewhere.includes(c.id),
      updateHint: outOfDate && !failed,
      versionLines: versionLines({
        managed,
        versionless: skipVersionCheck || staging,
        live,
        sha: disc?.currentSha,
        outOfDate,
        targetSha: disc?.targetSha,
      }),
      menuItems: rowMenuEntries({
        developerMode,
        sshHost: c.ssh?.host,
        deploymentId: c.deploymentId,
        busy,
        outOfDate,
        live,
        managed,
        previewPinned,
      }).map((e) => ({ label: e.label, danger: e.danger, onClick: handlers[e.action] ?? swallow })),
    };
  };

  let content: ReactNode = null;
  switch (contentKind) {
    case "settings":
      content = (
        <SettingsView
          auth={me}
          settings={settings}
          section={pickerPage ? "all" : settingsTab}
          developerVisible={developerVisible}
          showBack={pickerPage}
          onSaveSettings={saveSettings}
          onSignOut={() => {
            setPickerPage(false);
            setView("labs");
            window.silico.auth.signOutEverywhere().catch(swallow);
          }}
          onBack={() => {
            setPickerPage(false);
            setView("labs");
          }}
        />
      );
      break;
    case "lab-loading":
      if (lab) {
        const current = lab;
        content = (
          <LabLoadingScreen
            lab={current}
            cs={conn[current.id]}
            waking={!!labWaking[current.id]}
            logOpen={!!logOpen[current.id]}
            setLogOpen={(o) => setLogOpen((m) => ({ ...m, [current.id]: o }))}
            onLeave={() => {
              setLab(null);
              window.silico.labView.hide().catch(swallow);
              if (openingConn && openingConn.id === current.id) cancelOpening(openingConn);
            }}
          />
        );
      }
      break;
    case "edit":
      if (editing) {
        content = (
          <ConfigureForm
            key={editing.id}
            initial={editing}
            onCancel={() => setEditing(null)}
            onSave={async (d) => {
              await save(d);
            }}
          />
        );
      }
      break;
    case "add":
      content = (
        <AddWizard
          discovered={status === "ok" ? discovered : []}
          discoveryStatus={status}
          onRetryDiscovery={refreshDiscovery}
          connections={visible}
          auth={me}
          initialPick={addPick ?? undefined}
          onSwitchAccount={() => {
            setAdding(false);
            setAddPick(null);
            signOut().catch(swallow);
          }}
          onSave={async (draft) => {
            const saved = await save(draft);
            setJustAdded(saved.id);
            if (isManaged(saved) || isLocal(saved)) {
              setLab({ id: saved.id, title: saved.name || saved.deploymentId, state: "loading" });
            }
            setAdding(false);
            setAddPick(null);
            setOpeningId(saved.id);
            void connect(saved);
          }}
          onCancel={() => {
            setAdding(false);
            setAddPick(null);
          }}
        />
      );
      break;
    case "opening":
      if (openingConn && openingCs) {
        const c = openingConn;
        const showLog = logOpen[c.id] ?? (developerMode || verbose);
        content = (
          <OpeningScreen
            conn={c}
            cs={openingCs}
            showLog={showLog}
            setShowLog={(o) => setLogOpen((m) => ({ ...m, [c.id]: o }))}
            onRetry={() => openLab(c)}
            onSwitchAccount={() => {
              signOut().catch(swallow);
            }}
            onDismiss={() => setOpeningId(null)}
            onCancel={() => cancelOpening(c)}
            onHostKeyAccepted={() => void connect(c)}
          />
        );
      }
      break;
    case "labs-empty":
      content = (
        <LabsEmpty
          head={head}
          discoveryStatus={status}
          discovered={discovered}
          onAddDiscovered={(l) => {
            setPickerPage(labsPicker);
            setAddPick(l);
            setAdding(true);
          }}
          local={local}
        />
      );
      break;
    case "labs-list":
      content = (
        <LabsList
          head={head}
          rows={sortConnections(visible, justAdded).map(rowModel)}
          local={local}
          menuFor={menuFor}
          setMenuFor={setMenuFor}
          onOpen={openLab}
        />
      );
      break;
  }

  if (screen === "opening-full") {
    return (
      <div className="openfull">
        <Dragstrip />
        {content}
      </div>
    );
  }
  if (screen === "launch-gate") {
    return (
      <div className="openfull">
        <Dragstrip />
        <LaunchGate />
      </div>
    );
  }
  if (screen === "lab-cover") {
    return (
      <>
        <TitlebarStrip title={lab?.title ?? labCover.title ?? ""} nav={labNav} />
        <div className="labcover" aria-hidden>
          <Logo className="labcover__mark" />
        </div>
      </>
    );
  }
  if (screen === "lab-down" && lab) {
    const c = allConns.find((x) => x.id === lab.id);
    return (
      <LabStatePanel
        managed={c ? isManaged(c) : false}
        reason={lab.reason}
        onReconnect={
          c
            ? () => {
                setLab(null);
                openLab(c);
              }
            : undefined
        }
        onBack={() => {
          setLab(null);
          window.silico.labView.hide().catch(swallow);
        }}
      />
    );
  }

  const hideLabIfOpen = (): void => {
    if (lab) {
      setLab(null);
      window.silico.labView.hide().catch(swallow);
    }
  };

  if (labsPicker) {
    return (
      <PickerShell
        login={me.login}
        staging={staging}
        inSettings={view === "settings"}
        bodyRef={paneRef}
        onDesktopSettings={() => {
          winTouched.current = true;
          setPickerPage(true);
          setSettingsTab("notifications");
          setView("settings");
        }}
      >
        {content}
      </PickerShell>
    );
  }
  return (
    <FullShell
      login={me.login}
      staging={staging}
      labsActive={view === "labs"}
      activeTab={view === "settings" ? settingsTab : null}
      developerVisible={developerVisible}
      bodyRef={paneRef}
      onLabs={() => {
        winTouched.current = true;
        setView("labs");
        setEditing(null);
        setAdding(false);
        setAddPick(null);
        setOpeningId(null);
        hideLabIfOpen();
      }}
      onTab={(tab) => {
        winTouched.current = true;
        hideLabIfOpen();
        setSettingsTab(tab);
        setView("settings");
      }}
    >
      {content}
    </FullShell>
  );
}
