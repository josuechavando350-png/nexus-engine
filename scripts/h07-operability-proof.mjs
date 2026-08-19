import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(process.cwd());
const work = join(root, ".artifacts", "h07-clean-room");
const evidencePath = join(root, ".artifacts", "h07-operability-proof.json");
const releaseDir = join(root, "runtime", "target", "release");
const deployDir = join(work, "deployment");
const backupDir = join(work, "known-good-artifacts");
const gatewaySource = join(releaseDir, process.platform === "win32" ? "gatewayd.exe" : "gatewayd");
const factorySource = join(releaseDir, process.platform === "win32" ? "factory-line.exe" : "factory-line");
const gatewayDeployed = join(deployDir, process.platform === "win32" ? "gatewayd.exe" : "gatewayd");
const factoryDeployed = join(deployDir, process.platform === "win32" ? "factory-line.exe" : "factory-line");
const gatewayBackup = join(backupDir, process.platform === "win32" ? "gatewayd.exe" : "gatewayd");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

await rm(work, { recursive: true, force: true });
await mkdir(deployDir, { recursive: true });
await mkdir(backupDir, { recursive: true });
await mkdir(join(root, ".artifacts"), { recursive: true });

const phases = [];
async function phase(name, fn) {
  const started = performance.now();
  try {
    const detail = await fn();
    phases.push({ name, elapsedMs: Number((performance.now() - started).toFixed(3)), status: "PASS", ...(detail ?? {}) });
  } catch (error) {
    phases.push({ name, elapsedMs: Number((performance.now() - started).toFixed(3)), status: "FAIL", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

let gatewayDigest = "";
let factoryDigest = "";
let gatewayHealthOutput = "";
let factoryOutputDigest = "";

await phase("build-real-release-artifacts", async () => {
  run("cargo", ["build", "--locked", "--release", "-p", "gatewayd", "-p", "factory-line", "--manifest-path", "runtime/Cargo.toml"]);
  gatewayDigest = await sha256(gatewaySource);
  factoryDigest = await sha256(factorySource);
  return { gatewayDigest, factoryDigest };
});

await phase("deploy-real-binaries", async () => {
  await copyFile(gatewaySource, gatewayDeployed);
  await copyFile(factorySource, factoryDeployed);
  if (process.platform !== "win32") {
    await chmod(gatewayDeployed, 0o755);
    await chmod(factoryDeployed, 0o755);
  }
  if (await sha256(gatewayDeployed) !== gatewayDigest || await sha256(factoryDeployed) !== factoryDigest) {
    throw new Error("deployed binary digest differs from built release artifact");
  }
});

await phase("execute-real-health-path", async () => {
  gatewayHealthOutput = run(gatewayDeployed, [], {
    env: {
      ...process.env,
      NEXUS_LOG_LEVEL: "info",
      NEXUS_TELEMETRY_IDENTITY: "h07-telemetry",
      NEXUS_CONTROL_IDENTITY: "h07-control",
    },
  });
  return { exitCode: 0, stdoutDigest: createHash("sha256").update(gatewayHealthOutput).digest("hex") };
});

await phase("execute-real-end-to-end-action-path", async () => {
  const output = run(factoryDeployed, []);
  if (!output.includes("NEXUS V3") || !output.includes("factory-line")) {
    throw new Error("factory-line did not emit the expected NEXUS end-to-end execution transcript");
  }
  factoryOutputDigest = createHash("sha256").update(output).digest("hex");
  return { transcriptDigest: factoryOutputDigest };
});

await phase("backup-restore-offboard-real-state-api", async () => {
  const testPath = "packages/ontology/__tests__/h07-operability-state.test.ts";
  const output = run("pnpm", ["exec", "vitest", "run", testPath, "--reporter=default"]);
  if (!/1 passed|passed/i.test(output)) throw new Error("ontology state lifecycle test did not report success");
  return { test: testPath };
});

await phase("capture-known-good-release", async () => {
  await copyFile(gatewayDeployed, gatewayBackup);
  if (await sha256(gatewayBackup) !== gatewayDigest) throw new Error("known-good artifact backup digest mismatch");
});

await phase("rollback-deployed-artifact", async () => {
  await writeFile(gatewayDeployed, "corrupted deployment\n", "utf8");
  if (await sha256(gatewayDeployed) === gatewayDigest) throw new Error("rollback fault injection did not alter the deployment");
  await copyFile(gatewayBackup, gatewayDeployed);
  if (process.platform !== "win32") await chmod(gatewayDeployed, 0o755);
  if (await sha256(gatewayDeployed) !== gatewayDigest) throw new Error("rollback did not restore exact known-good artifact bytes");
  run(gatewayDeployed, [], {
    env: {
      ...process.env,
      NEXUS_LOG_LEVEL: "info",
      NEXUS_TELEMETRY_IDENTITY: "h07-telemetry",
      NEXUS_CONTROL_IDENTITY: "h07-control",
    },
  });
  return { restoredDigest: gatewayDigest, postRollbackExitCode: 0 };
});

const evidence = {
  proof: "H-07 executable clean-room reference lifecycle over real NEXUS code and release artifacts",
  generatedAt: new Date().toISOString(),
  commit: run("git", ["rev-parse", "HEAD"]).trim(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  artifacts: {
    gatewayd: { sha256: gatewayDigest },
    factoryLine: { sha256: factoryDigest, executionTranscriptSha256: factoryOutputDigest },
  },
  phases,
  claims: {
    releaseArtifactBuild: "VERIFIED",
    releaseArtifactDeployment: "VERIFIED_IN_CLEAN_ROOM_REFERENCE_ENVIRONMENT",
    executableStartupHealthInvariant: "VERIFIED",
    endToEndNexusExecution: "VERIFIED",
    ontologyBackupRestoreOffboardingApi: "VERIFIED_IN_REFERENCE_ADAPTER",
    byteExactKnownGoodArtifactRollback: "VERIFIED",
    productionInfrastructureDeployment: "NOT VERIFIED",
    productionRtoRpo: "NOT VERIFIED",
    independentHumanOperatorRun: "NOT VERIFIED",
  },
  limitations: [
    "This proof executes real NEXUS release binaries and real ontology persistence APIs; it no longer models deploy/health/backup/restore/offboarding as JSON file copies.",
    "The repository does not contain credentials or a customer production environment, so production infrastructure deployment and production RTO/RPO remain explicitly NOT VERIFIED rather than being simulated.",
    "Independent-human-operator acceptance remains a separate evidence item.",
  ],
};

await writeJson(evidencePath, evidence);
console.log(JSON.stringify(evidence, null, 2));
