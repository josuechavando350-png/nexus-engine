#!/usr/bin/env node
import { discoverWorkspaceApps } from "./client-fleet.mjs";

try {
  process.stdout.write(`${JSON.stringify(discoverWorkspaceApps(process.cwd()))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
