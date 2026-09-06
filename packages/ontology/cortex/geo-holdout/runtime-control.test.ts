import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { GeoHoldoutControlError, SqliteGeoHoldoutControl } from "./runtime-control";

const dirs: string[] = [];

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), "nexus-cortex12-control-"));
  dirs.push(directory);
  return join(directory, "control.sqlite");
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CORTEX #12 durable runtime control", () => {
  it("defaults fail-closed to KILLED and persists ACTIVE across restart", () => {
    const database = path();
    const first = new SqliteGeoHoldoutControl(database, () => Date.parse("2026-09-06T12:00:00.000Z"));
    expect(first.read()).toMatchObject({ mode: "KILLED", revision: 0 });
    expect(first.setMode("ACTIVE", 0)).toMatchObject({ mode: "ACTIVE", revision: 1 });
    first.close();

    const reopened = new SqliteGeoHoldoutControl(database);
    expect(reopened.read()).toMatchObject({ mode: "ACTIVE", revision: 1 });
    reopened.close();
  });

  it("uses compare-and-set revisions and refuses stale control writes", () => {
    const control = new SqliteGeoHoldoutControl(path());
    const active = control.setMode("ACTIVE", 0);
    expect(() => control.setMode("OBSERVE_ONLY", 0)).toThrowError(GeoHoldoutControlError);
    const observed = control.setMode("OBSERVE_ONLY", active.revision);
    expect(observed).toMatchObject({ mode: "OBSERVE_ONLY", revision: 2 });
    const killed = control.setMode("KILLED", observed.revision);
    expect(killed).toMatchObject({ mode: "KILLED", revision: 3 });
    control.close();
  });
});
