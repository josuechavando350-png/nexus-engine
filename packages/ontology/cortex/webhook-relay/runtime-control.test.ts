import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWebhookRelayControl } from "./runtime-control";

const dirs: string[] = [];
function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-cortex11-control-"));
  dirs.push(dir);
  return join(dir, "control.sqlite");
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("CORTEX #11 durable relay control", () => {
  it("defaults KILLED and advances through monotonic compare-and-set revisions", () => {
    let now = Date.parse("2026-09-06T12:00:00.000Z");
    const control = new SqliteWebhookRelayControl(databasePath(), () => now);
    expect(control.read()).toEqual({ mode: "KILLED", revision: 0, updatedAt: "1970-01-01T00:00:00.000Z" });
    expect(control.setMode("OBSERVE_ONLY", 0)).toEqual({ mode: "OBSERVE_ONLY", revision: 1, updatedAt: "2026-09-06T12:00:00.000Z" });
    now += 1_000;
    expect(control.setMode("ACTIVE", 1)).toEqual({ mode: "ACTIVE", revision: 2, updatedAt: "2026-09-06T12:00:01.000Z" });
    expect(() => control.setMode("KILLED", 1)).toThrowError(/revision conflict/u);
    control.close();
  });

  it("persists the control state across reopen", () => {
    const path = databasePath();
    const first = new SqliteWebhookRelayControl(path, () => Date.parse("2026-09-06T12:00:00.000Z"));
    first.setMode("ACTIVE", 0);
    first.close();
    const second = new SqliteWebhookRelayControl(path);
    expect(second.read()).toMatchObject({ mode: "ACTIVE", revision: 1 });
    second.close();
  });
});
