/**
 * Test helper (architect-owned, shared): build a MainContext for unit tests.
 *
 * Every service you do not pass is replaced by a Proxy whose methods throw
 * `not stubbed: <service>.<method>` when called, so a test fails loudly if
 * the code under test reaches an unexpected collaborator.
 *
 *   const ctx = makeTestContext({
 *     settings: { get: async () => DEFAULT_SETTINGS, ... } as SettingsService,
 *     env: testEnv({ userDataPath: () => tmpDir }),
 *   });
 *
 * Partial stubs are fine: `stub<AuthService>({ status: async () => ... })`
 * fills the remaining methods with throwing placeholders.
 */
import { createMainContext } from "../../../src/main/services";
import type { AppEnv, Logger, LoggerFactory, MainContext, ServiceName } from "../../../src/main/services";

/** Wrap a partial implementation; missing members throw when called. */
export function stub<T extends object>(name: string, partial: Partial<T> = {}): T {
  return new Proxy(partial as T, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (prop === "then") return undefined; // not a thenable
      return () => {
        throw new Error(`not stubbed: ${name}.${String(prop)}`);
      };
    },
  });
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
export const silentLoggerFactory: LoggerFactory = () => silentLogger;

export function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    isPackaged: false,
    isTestMode: true,
    platform: "darwin",
    appVersion: "0.0.0-test",
    build: "test",
    rendererUrl: undefined,
    userDataPath: () => "/tmp/rea-claude-test",
    preloadPath: (n) => `/tmp/out/preload/${n}.js`,
    rendererHtmlPath: () => "/tmp/out/renderer/index.html",
    iconPath: () => "/tmp/resources/icon.png",
    ...overrides,
  };
}

type Overrides = { [K in ServiceName]?: Partial<MainContext[K]> };

export function makeTestContext(overrides: Overrides = {}): MainContext {
  const builder = createMainContext();
  const names: ServiceName[] = [
    "settings",
    "telemetry",
    "auth",
    "signup",
    "deepLinks",
    "returns",
    "connections",
    "ssh",
    "lab",
    "windows",
    "bridge",
    "updater",
  ];
  builder.provide("env", testEnv((overrides.env ?? {}) as Partial<AppEnv>));
  builder.provide("logger", (overrides.logger as LoggerFactory | undefined) ?? silentLoggerFactory);
  for (const n of names) {
    const partial: object = overrides[n] ?? {};
    builder.provide(n, stub<object>(n, partial) as never);
  }
  return builder.ctx;
}
