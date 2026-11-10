import { describe, expect, it, vi } from "vitest";
import { DOCKER_PS_ARGS, detectLocalStacks } from "../../../src/main/lab/localStacks";

describe("detectLocalStacks", () => {
  it("runs docker ps with the filter/format and a 5 s timeout", async () => {
    const execFile = vi.fn(async () => ({ stdout: "silico-local-a-web-12\t127.0.0.1:5180->5173/tcp\t/wt/a\tmain\n" }));
    expect(await detectLocalStacks(execFile)).toEqual([{ project: "silico-local-a", port: 5180, worktree: "/wt/a", branch: "main" }]);
    expect(execFile).toHaveBeenCalledWith("docker", [...DOCKER_PS_ARGS], { timeout: 5000 });
    expect(DOCKER_PS_ARGS).toEqual([
      "ps",
      "--filter",
      "name=silico-local-",
      "--format",
      '{{.Names}}\t{{.Ports}}\t{{.Label "com.silico.local.worktree"}}\t{{.Label "com.silico.local.branch"}}',
    ]);
  });
  it("any failure → []", async () => {
    expect(await detectLocalStacks(async () => Promise.reject(new Error("ENOENT")))).toEqual([]);
  });
});
