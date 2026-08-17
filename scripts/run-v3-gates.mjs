#!/usr/bin/env node

/**
 * Runs the V3 architecture gates against the isolated Rust worktree when CI
 * provides one. The V3 gate suite intentionally invokes cargo fmt/clippy/test/
 * build when a Rust toolchain is available; running it in the main checkout
 * can legitimately refresh Cargo.lock and violate M-03 build hygiene.
 *
 * Local execution is unchanged: without NEXUS_LOCK_WORKTREE, V3 runs against
 * the caller's current checkout.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const gateScript = join(scriptDir, "v3-architecture-gates.mjs");
const isolatedRoot = process.env.NEXUS_LOCK_WORKTREE;

if (isolatedRoot) {
  if (!existsSync(join(isolatedRoot, "runtime", "Cargo.toml"))) {
    console.error(`NEXUS_LOCK_WORKTREE is invalid: ${isolatedRoot}`);
    process.exit(1);
  }
  process.chdir(isolatedRoot);
  console.log(`V3 gates: using isolated Rust worktree ${isolatedRoot}`);
}

await import(pathToFileURL(gateScript).href);
