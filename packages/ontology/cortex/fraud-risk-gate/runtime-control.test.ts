import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { RiskGateControlError, SqliteRiskGateControl } from "./runtime-control";

const dirs: string[] = [];
function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-cortex14-control-"));
  dirs.push(dir);
  return join(dir, "control.sqlite");
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("CORTEX #14 durable control", () => {
  it("starts fail-closed when no durable control has been initialized", () => {
    const control = new SqliteRiskGateControl(databasePath());
    expect(control.read()).toEqual({ mode: "KILLED", revision: 0, updatedAt: new Date(0).toISOString() });
    control.close();
  });

  it("allows explicit CAS initialization and preserves an operator kill across restart", () => {
    const path = databasePath();
    const first = new SqliteRiskGateControl(path, () => Date.parse("2026-09-06T12:00:00.000Z"));
    expect(first.setMode("ACTIVE", 0)).toMatchObject({ mode: "ACTIVE", revision: 1 });
    expect(first.setMode("KILLED", 1)).toMatchObject({ mode: "KILLED", revision: 2 });
    first.close();

    const reopened = new SqliteRiskGateControl(path, () => Date.parse("2026-09-06T13:00:00.000Z"));
    expect(reopened.read()).toMatchObject({ mode: "KILLED", revision: 2 });
    expect(() => reopened.setMode("ACTIVE", 0)).toThrowError(RiskGateControlError);
    reopened.close();
  });

  it("keeps initialize idempotent without overwriting an existing operator decision", () => {
    const path = databasePath();
    const first = new SqliteRiskGateControl(path);
    expect(first.initialize("OBSERVE_ONLY")).toMatchObject({ mode: "OBSERVE_ONLY", revision: 1 });
    expect(first.setMode("KILLED", 1)).toMatchObject({ mode: "KILLED", revision: 2 });
    first.close();

    const reopened = new SqliteRiskGateControl(path);
    expect(reopened.initialize("ACTIVE")).toMatchObject({ mode: "KILLED", revision: 2 });
    reopened.close();
  });

  it("uses revision CAS so stale operators cannot overwrite newer control state", () => {
    const control = new SqliteRiskGateControl(databasePath());
    expect(control.setMode("OBSERVE_ONLY", 0)).toMatchObject({ mode: "OBSERVE_ONLY", revision: 1 });
    expect(control.setMode("ACTIVE", 1)).toMatchObject({ mode: "ACTIVE", revision: 2 });
    expect(() => control.setMode("KILLED", 1)).toThrowError(RiskGateControlError);
    expect(control.read()).toMatchObject({ mode: "ACTIVE", revision: 2 });
    control.close();
  });

  it("rejects malformed modes and revisions rather than guessing control intent", () => {
    const control = new SqliteRiskGateControl(databasePath());
    expect(() => control.initialize("BROKEN" as never)).toThrowError(/initial risk gate mode/u);
    expect(() => control.setMode("ACTIVE", -1)).toThrowError(/control request/u);
    expect(() => control.setMode("BROKEN" as never, 0)).toThrowError(/control request/u);
    control.close();
  });
});
