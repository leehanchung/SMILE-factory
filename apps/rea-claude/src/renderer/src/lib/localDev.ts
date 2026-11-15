/** Local dev stacks (docker `silico-local-*`) [renderer §4.5, §6]. */
import { LOCAL_DEPLOYMENT_ID } from "@shared/config";
import type { Connection, ConnectionUpsert, LocalStack } from "@shared/ipc";

export const LOCAL_DEV_DEPLOYMENT_ID = LOCAL_DEPLOYMENT_ID;

const TRUNK_BRANCHES = new Set(["main", "master", "HEAD", "staging"]);

/** Friendly name: feature branch leaf, else worktree, else project. */
export function localStackName(s: Pick<LocalStack, "project"> & Partial<LocalStack>): string {
  const branch = (s.branch ?? "").trim();
  if (branch && !TRUNK_BRANCHES.has(branch)) {
    const leaf = branch.split("/").pop();
    return leaf ? leaf : branch;
  }
  const worktree = (s.worktree ?? "").trim();
  if (worktree) return worktree;
  return s.project.replace(/^silico-local-/, "local ");
}

export interface LocalDevInput {
  name: string;
  port: number;
  icon?: string;
}

/** Draft for a local Lab reached over http://localhost:<port>. Throws on a bad port. */
export function buildLocalDevDraft(input: LocalDevInput): ConnectionUpsert {
  const { port } = input;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid local Lab port: ${port}`);
  }
  return {
    name: input.name.trim() || `Local dev (:${port})`,
    icon: input.icon ?? "cpu",
    deploymentId: LOCAL_DEV_DEPLOYMENT_ID,
    labUrl: `http://localhost:${port}`,
    routeMode: "local",
  };
}

/** The in-memory connection used to open a detected stack (never persisted). */
export function localStackConnection(s: LocalStack): Connection {
  return {
    ...buildLocalDevDraft({ name: localStackName(s), port: s.port }),
    id: `local:${s.project}`,
  };
}
