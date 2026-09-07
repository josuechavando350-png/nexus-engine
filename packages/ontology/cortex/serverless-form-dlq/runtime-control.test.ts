import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Cortex20ControlError, SqliteCortex20Control } from "./runtime-control";

const dirs: string[] = [];
function database(): string { const dir = mkdtempSync(join(tmpdir(), "nexus-cortex20-control-")); dirs.push(dir); return join(dir, "control.sqlite"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("CORTEX #20 durable runtime control", () => {
  it("defaults KILLED and persists explicit mode", () => {
    const db = database(); let control = new SqliteCortex20Control(db);
    expect(control.read()).toMatchObject({ mode: "KILLED", revision: 0 }); expect(control.setMode("ACTIVE", 0)).toMatchObject({ mode: "ACTIVE", revision: 1 });
    control.close(); control = new SqliteCortex20Control(db); expect(control.read()).toMatchObject({ mode: "ACTIVE", revision: 1 }); control.close();
  });
  it("rejects stale revision writers", () => {
    const control = new SqliteCortex20Control(database()); control.setMode("OBSERVE_ONLY", 0); control.setMode("KILLED", 1);
    expect(() => control.setMode("ACTIVE", 1)).toThrowError(Cortex20ControlError); control.close();
  });
});
