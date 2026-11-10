/**
 * Contract test: every literal IPC channel REA observed in the shipped Silico
 * 0.137.0 bundle (docs/evidence/rea-ipc-inventory.json) must be declared in
 * @shared/ipc, and every channel we declare must exist in the original
 * (no invented channels). This pins decision D2 (same channel names).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LabEventChannel,
  LabInvokeChannel,
  LabSendChannel,
  ShellEventChannel,
  ShellInvokeChannel,
} from "@shared/ipc";

interface Inventory {
  evidence_id: string;
  channels: Record<string, string[]>;
}

const inventory = JSON.parse(
  readFileSync(resolve(__dirname, "../../docs/evidence/rea-ipc-inventory.json"), "utf8"),
) as Inventory;

const declared = new Set<string>(
  [ShellInvokeChannel, ShellEventChannel, LabInvokeChannel, LabSendChannel, LabEventChannel].flatMap(
    (group) => Object.values(group) as string[],
  ),
);
const observed = new Set(Object.keys(inventory.channels));

describe("IPC contract vs REA evidence", () => {
  it("records the evidence id it was generated from", () => {
    expect(inventory.evidence_id).toMatch(/^ev_[0-9a-f]{64}$/);
  });

  it("declares every channel observed in the original app", () => {
    const missing = [...observed].filter((c) => !declared.has(c)).sort();
    expect(missing).toEqual([]);
  });

  it("declares no channel absent from the original app", () => {
    const invented = [...declared].filter((c) => !observed.has(c)).sort();
    expect(invented).toEqual([]);
  });
});
