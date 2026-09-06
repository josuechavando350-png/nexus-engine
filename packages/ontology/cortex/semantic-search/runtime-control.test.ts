import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Cortex15ControlError, SqliteCortex15Control } from "./runtime-control";

const dirs: string[] = [];
function database(): string { const dir = mkdtempSync(join(tmpdir(), "nexus-cortex15-control-")); dirs.push(dir); return join(dir, "control.sqlite"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("CORTEX #15 durable runtime control", () => {
  it("defaults fail-closed and persists explicit mode across reopen", () => {
    const db = database();
    let control = new SqliteCortex15Control(db, () => Date.parse("2026-09-06T00:00:00.000Z"));
    expect(control.read()).toEqual({ mode: "KILLED", revision: 0, updatedAt: "1970-01-01T00:00:00.000Z" });
    expect(control.setMode("ACTIVE", 0)).toEqual({ mode: "ACTIVE", revision: 1, updatedAt: "2026-09-06T00:00:00.000Z" });
    control.close();
    control = new SqliteCortex15Control(db);
    expect(control.read().mode).toBe("ACTIVE");
    expect(control.read().revision).toBe(1);
    control.close();
  });

  it("uses revision CAS and never accepts a stale control writer", () => {
    const db = database();
    const control = new SqliteCortex15Control(db);
    control.setMode("OBSERVE_ONLY", 0);
    expect(control.setMode("KILLED", 1).revision).toBe(2);
    expect(() => control.setMode("ACTIVE", 1)).toThrowError(Cortex15ControlError);
    expect(control.read()).toMatchObject({ mode: "KILLED", revision: 2 });
    control.close();
  });
});
