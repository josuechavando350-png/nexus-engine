#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-z][a-z0-9-]*$/;
const REQUIRED_IDS = ["scroll-rig", "seam-transitions", "photoswipe", "embla-carousel"];

export function validateRegistry(registry) {
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.modules) || registry.modules.length !== 4) {
    throw new Error("Expected the four-module web-experience registry, schemaVersion 1.");
  }
  const seen = new Set();
  for (const entry of registry.modules) {
    if (!ID.test(entry.id) || !REQUIRED_IDS.includes(entry.id) || seen.has(entry.id)) throw new Error("Invalid or duplicate module id.");
    seen.add(entry.id);
    if (!SHA.test(entry.commit) || !SHA.test(entry.licenseBlob)) throw new Error(`Unpinned module: ${entry.id}`);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(entry.repository)) {
      throw new Error(`Invalid upstream URL: ${entry.id}`);
    }
    if (entry.path !== `vendor/web-experience/${entry.id}` || entry.licenseFile !== "LICENSE") {
      throw new Error(`Unsafe module path: ${entry.id}`);
    }
    if (entry.sourceLicense !== "MIT" || typeof entry.activation !== "string" || !entry.activation.trim()) {
      throw new Error(`Incomplete provenance: ${entry.id}`);
    }
  }
  return registry;
}

export function selectModules(registry, names) {
  validateRegistry(registry);
  if (names.length === 0 || (names.length === 1 && names[0] === "all")) return registry.modules;
  if (new Set(names).size !== names.length) throw new Error("Duplicate module selection.");
  return names.map((name) => {
    const entry = registry.modules.find((item) => item.id === name);
    if (!entry) throw new Error(`Unknown module: ${name}`);
    return entry;
  });
}

function git(args, cwd = ROOT) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, timeout: 600_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

export function parseGitlinks(output) {
  return output.split("\n").filter(Boolean).map((line) => {
    const match = /^(\d{6}) ([a-f0-9]{40}) ([0-3])\t(.+)$/.exec(line);
    if (!match) throw new Error("Malformed git index entry.");
    return { mode: match[1], commit: match[2], stage: match[3], path: match[4] };
  });
}

export function validateGitlink(entry, output) {
  const links = parseGitlinks(output);
  if (links.length !== 1 || links[0].mode !== "160000" || links[0].stage !== "0" ||
      links[0].path !== entry.path || links[0].commit !== entry.commit) {
    throw new Error(`Gitlink does not match registry: ${entry.id}`);
  }
}

function verifyEntry(entry, sources) {
  validateGitlink(entry, git(["ls-files", "--stage", "--", entry.path]));
  const prefix = `submodule.web-experience-${entry.id}`;
  const path = git(["config", "--file", ".gitmodules", "--get", `${prefix}.path`]);
  const url = git(["config", "--file", ".gitmodules", "--get", `${prefix}.url`]);
  if (path !== entry.path || url !== entry.repository) throw new Error(`Submodule configuration drift: ${entry.id}`);
  if (!sources) return;
  const directory = resolve(ROOT, entry.path);
  if (!directory.startsWith(`${ROOT}${sep}`) || !existsSync(resolve(directory, ".git"))) {
    throw new Error(`Source unavailable: ${entry.id}. Run fetch first.`);
  }
  if (git(["rev-parse", "HEAD"], directory) !== entry.commit) throw new Error(`Source revision drift: ${entry.id}`);
  if (git(["status", "--porcelain", "--untracked-files=all"], directory)) throw new Error(`Source has local changes: ${entry.id}`);
  if (git(["hash-object", "--", entry.licenseFile], directory) !== entry.licenseBlob) {
    throw new Error(`License content drift: ${entry.id}`);
  }
}

export function main(args = process.argv.slice(2)) {
  const registry = validateRegistry(JSON.parse(readFileSync(resolve(ROOT, "vendor/web-experience/registry.json"), "utf8")));
  const [command = "list", ...rest] = args;
  const sources = rest.includes("--sources");
  if (sources && command !== "verify") throw new Error("--sources is valid only with verify.");
  const selected = selectModules(registry, rest.filter((arg) => arg !== "--sources"));
  if (command === "list") {
    for (const entry of selected) console.log(`${entry.id}\t${entry.commit}\t${entry.kind}\n  ${entry.activation}`);
    return;
  }
  if (command !== "fetch" && command !== "verify") throw new Error("Usage: node scripts/web-experience.mjs [list|fetch|verify] [all|module-id ...] [--sources]");
  for (const entry of selected) verifyEntry(entry, false);
  if (command === "fetch") {
    // Never reset a modified source checkout and never follow an upstream branch.
    for (const entry of selected) {
      const directory = resolve(ROOT, entry.path);
      if (existsSync(resolve(directory, ".git")) && git(["status", "--porcelain", "--untracked-files=all"], directory)) {
        throw new Error(`Refusing to overwrite modified source: ${entry.id}`);
      }
    }
    const paths = selected.map((entry) => entry.path);
    git(["submodule", "sync", "--", ...paths]);
    git(["submodule", "update", "--init", "--checkout", "--", ...paths]);
  }
  for (const entry of selected) verifyEntry(entry, sources || command === "fetch");
  console.log(`Verified ${selected.length} module(s)${sources || command === "fetch" ? " including source revisions and license blobs" : " (registry, gitlinks and URLs only)"}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
