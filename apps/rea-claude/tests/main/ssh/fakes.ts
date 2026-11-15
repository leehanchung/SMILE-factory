/** Fake child processes for ssh-area tests (never spawns anything real). */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { SpawnFn } from "../../../src/main/ssh/env";

export interface FakeResponse {
  /** Emit an `error` with this code instead of `spawn` (e.g. "ENOENT", "EACCES"). */
  errorCode?: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  /** Never close (for timeout tests). */
  hang?: boolean;
}

export interface SpawnCall {
  cmd: string;
  args: string[];
  opts: SpawnOptions | undefined;
  stdin: string;
  killed: (NodeJS.Signals | number | undefined)[];
  child: ChildProcess;
}

export type FakeHandler = (cmd: string, args: string[], stdin: string) => FakeResponse;

export function fakeSpawn(handler: FakeHandler): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    const ee = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const call: SpawnCall = { cmd, args: [...args], opts, stdin: "", killed: [], child: undefined as unknown as ChildProcess };
    const stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        call.stdin += chunk.toString();
        cb();
      },
    });
    const child = Object.assign(ee, {
      stdout,
      stderr,
      stdin,
      kill(sig?: NodeJS.Signals | number) {
        call.killed.push(sig);
        return true;
      },
    }) as unknown as ChildProcess;
    call.child = child;
    calls.push(call);
    setImmediate(() => {
      // Decide the response now so callers had a chance to write stdin.
      const probe = handler(cmd, [...args], "");
      if (probe.errorCode) {
        ee.emit("error", Object.assign(new Error(`spawn ${cmd} ${probe.errorCode}`), { code: probe.errorCode }));
        return;
      }
      ee.emit("spawn");
      setImmediate(() => {
        setImmediate(() => {
          const r = handler(cmd, [...args], call.stdin);
          if (r.hang) return;
          if (r.stdout) stdout.write(r.stdout);
          if (r.stderr) stderr.write(r.stderr);
          stdout.end();
          stderr.end();
          setImmediate(() => ee.emit("close", r.code === undefined ? 0 : r.code));
        });
      });
    });
    return child;
  };
  return { spawn, calls };
}
