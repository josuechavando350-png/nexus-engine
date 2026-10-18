import { isAbsolute } from "node:path";
import { SqliteGeoExperimentRegistry } from "../../geo-holdout/registry.js";
import { SqliteGeoHoldoutControl } from "../../geo-holdout/runtime-control.js";
import type { SeoGeoIncrementalityPolicy } from "./contracts.js";
import { SeoGeoIncrementalityError } from "./contracts.js";
import { SeoGeoIncrementalityRuntime } from "./runtime.js";

export interface SqliteSeoGeoIncrementalityRuntime {
  readonly runtime: SeoGeoIncrementalityRuntime;
  readonly registry: SqliteGeoExperimentRegistry;
  readonly control: SqliteGeoHoldoutControl;
  close(): void;
}

export function createSqliteSeoGeoIncrementalityRuntime(input: {
  readonly databasePath: string;
  readonly policy: SeoGeoIncrementalityPolicy;
  readonly now?: () => number;
}): SqliteSeoGeoIncrementalityRuntime {
  if (!input || typeof input !== "object" || !input.databasePath || !isAbsolute(input.databasePath)) {
    throw new SeoGeoIncrementalityError("INVALID_CONFIG", "SEO #12 durable databasePath must be absolute");
  }
  const now = input.now ?? Date.now;
  const control = new SqliteGeoHoldoutControl(input.databasePath, now);
  const registry = new SqliteGeoExperimentRegistry(input.databasePath, now, () => control.read().mode === "ACTIVE");
  const runtime = new SeoGeoIncrementalityRuntime({ policy: input.policy, registry });
  let closed = false;
  return Object.freeze({
    runtime,
    registry,
    control,
    close: () => {
      if (closed) return;
      closed = true;
      registry.close();
      control.close();
    },
  });
}
