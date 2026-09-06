import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Cortex18ControlError, SqliteCortex18Control } from "./runtime-control";

const dirs: string[] = [];
function database(): string { const dir = mkdtempSync(join(tmpdir(), "nexus-cortex18-control-")); dirs.push(dir); return join(dir, "control.sqlite"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("CORTEX #18 durable runtime control", () => {
  it("defaults KILLED and persists explicit mode", () => {
    const db = database(); let control = new SqliteCortex18Control(db);
    expect(control.read()).toMatchObject({ mode: "KILLED", revision: 0 });
    expect(control.setMode("ACTIVE", 0)).toMatchObject({ mode: "ACTIVE", revision: 1 });
    control.close(); control = new SqliteCortex18Control(db);
    expect(control.read()).toMatchObject({ mode: "ACTIVE", revision: 1 }); control.close();
  });
  it("rejects stale revision writers", () => {
    const control = new SqliteCortex18Control(database()); control.setMode("OBSERVE_ONLY", 0); control.setMode("KILLED", 1);
    expect(() => control.setMode("ACTIVE", 1)).toThrowError(Cortex18ControlError); control.close();
  });
});
