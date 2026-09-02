#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverClientApps } from "./client-fleet.mjs";
import { installRepositoryTypeScriptRuntime } from "./typescript-source-runtime.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(repositoryRoot, "artifacts", "decision-trace");
const SHA1 = /^[a-f0-9]{40}$/;

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function cleanWorktree() {
  return git(["status", "--porcelain"]) === "";
}

async function main() {
  const sourceRevision = git(["rev-parse", "HEAD"]);
  if (!SHA1.test(sourceRevision)) throw new Error("decision trace requires a full lowercase Git SHA-1 HEAD");
  if (!cleanWorktree()) throw new Error("decision trace requires a completely clean worktree before exact-SHA client builds");

  const clients = discoverClientApps(repositoryRoot);
  const results = [];
  const pendingTraceWrites = [];

  if (clients.length === 0) {
    mkdirSync(outputDir, { recursive: true });
    const report = {
      authority: "NEXUS_CLIENT_DECISION_PROVENANCE_V2",
      verdict: "NOT_TESTED",
      reason: "NO_CLIENT_APPS",
      sourceRevision,
      clientCount: 0,
      clients: [],
    };
    writeFileSync(join(outputDir, "index.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const hooks = installRepositoryTypeScriptRuntime();
  try {
    const [
      { evaluateClientDecisionManifest },
      { readProjects },
      { buildTarget, validateBuildManifest },
      { inspectRenderedNexusElements },
    ] = await Promise.all([
      import("./client-decision-contract.mjs"),
      import("../packages/mcp-server/src/projects.ts"),
      import("../packages/mcp-server/src/build.ts"),
      import("../packages/mcp-server/src/project-server.ts"),
    ]);

    const projects = await readProjects(repositoryRoot);
    for (const projectId of clients) {
      try {
        const sourcePath = join(repositoryRoot, "apps", projectId, "nexus-decisions.json");
        if (!existsSync(sourcePath)) throw new Error("MISSING_DECISION_MANIFEST");
        const project = projects.find((candidate) => candidate.slug === projectId);
        if (!project || !project.workspaceMember || project.kind !== "CLIENT" || project.clientProject !== true) {
          throw new Error("CLIENT_ADMISSION_MISMATCH");
        }

        const manifest = JSON.parse(readFileSync(sourcePath, "utf8"));
        const build = await buildTarget(repositoryRoot, project, sourceRevision, `decision-${projectId}-${sourceRevision.slice(0, 12)}`);
        if (!build.manifest) {
          throw new Error(build.unavailableReason ? `EXACT_SHA_BUILD_UNAVAILABLE: ${build.unavailableReason}` : `EXACT_SHA_BUILD_FAILED: ${build.exitCode ?? "unknown"}`);
        }
        if (!(await validateBuildManifest(repositoryRoot, project, sourceRevision, build.manifest))) {
          throw new Error("EXACT_SHA_BUILD_MANIFEST_INVALID");
        }
        if (!cleanWorktree()) throw new Error("EXACT_SHA_BUILD_DIRTIED_WORKTREE");

        const rendered = await inspectRenderedNexusElements(repositoryRoot, project);
        if (!cleanWorktree()) throw new Error("DOM_INSPECTION_DIRTIED_WORKTREE");
        const { trace, coverage } = evaluateClientDecisionManifest({ projectId, renderedElementIds: rendered.elementIds, manifest });
        const tracePath = join(outputDir, `${projectId}.json`);
        const payload = {
          schemaVersion: 2,
          authority: "NEXUS_CLIENT_DECISION_PROVENANCE_V2",
          projectId,
          sourceRevision,
          route: rendered.route,
          build: {
            authority: build.manifest.authority,
            target: build.manifest.target,
            outputDigest: build.manifest.outputDigest,
            manifestSha256: build.manifest.manifestSha256,
          },
          renderedElementIds: rendered.elementIds,
          renderedHtmlByteLength: rendered.htmlByteLength,
          trace,
          coverage,
        };
        pendingTraceWrites.push({ path: tracePath, payload });
        results.push({
          projectId,
          status: "PASS",
          traceHash: trace.traceHash,
          tracePath: `artifacts/decision-trace/${projectId}.json`,
          entryCount: trace.entries.length,
          elementCount: coverage.requiredElementIds.length,
          buildOutputDigest: build.manifest.outputDigest,
        });
      } catch (error) {
        results.push({ projectId, status: "FAIL", reason: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    hooks.deregister();
  }

  mkdirSync(outputDir, { recursive: true });
  for (const pending of pendingTraceWrites) writeFileSync(pending.path, `${JSON.stringify(pending.payload, null, 2)}\n`);
  const verdict = results.every((result) => result.status === "PASS") ? "PASS" : "FAIL";
  const report = {
    authority: "NEXUS_CLIENT_DECISION_PROVENANCE_V2",
    verdict,
    sourceRevision,
    clientCount: clients.length,
    clients: results.sort((a, b) => a.projectId.localeCompare(b.projectId, "en")),
  };
  writeFileSync(join(outputDir, "index.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (verdict === "FAIL") process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
