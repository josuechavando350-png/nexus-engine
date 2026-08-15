import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
let failures = 0;

function pass(message) {
  console.log(`PASS  ${message}`);
}

function fail(message) {
  failures += 1;
  console.error(`FAIL  ${message}`);
}

function requirePath(path) {
  if (existsSync(join(root, path))) {
    pass(`artifact ${path}`);
  } else {
    fail(`missing artifact ${path}`);
  }
}

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

const requiredArtifacts = [
  "NEXUS_V7_ARCHITECTURE_PLAN.md",
  "docs/architecture/V7_CURRENT_STATE.md",
  "docs/evidence/NEXUS_V7_EVIDENCE.md",
  "packages/kernel/package.json",
  "packages/kernel/index.ts",
  "runtime/crates/nexus-kernel/Cargo.toml",
  "runtime/crates/nexus-kernel/src/lib.rs",
  "tests/v7-boundaries.test.ts"
];

for (const artifact of requiredArtifacts) {
  requirePath(artifact);
}

const packageJson = JSON.parse(read("packages/kernel/package.json"));
if (packageJson.name === "@nexus/kernel" && packageJson.version === "7.0.0") {
  pass("TypeScript Kernel package is versioned for V7");
} else {
  fail("TypeScript Kernel package must be @nexus/kernel version 7.0.0");
}

const kernelSource = read("packages/kernel/index.ts");
const forbiddenTs = ["react", "next", "@nexus/core", "@nexus/experience", "@nexus/experimental"];
const tsBoundaryFailures = failures;
for (const forbidden of forbiddenTs) {
  if (kernelSource.includes(`from "${forbidden}`) || kernelSource.includes(`from '${forbidden}`)) {
    fail(`TypeScript Kernel imports forbidden dependency ${forbidden}`);
  }
}
if (failures === tsBoundaryFailures) {
  pass("TypeScript Kernel has no forbidden Experience/Core imports");
}

const requiredDomains = [
  "ENTERPRISE_ONTOLOGY",
  "CONNECTOR_FABRIC",
  "DECISION_MEMORY",
  "POLICY_GRAPH",
  "DURABLE_WORKFLOWS",
  "AGENT_GOVERNANCE",
  "EXECUTION_FABRIC",
  "EVIDENCE_PLANE",
  "OUTCOME_INTELLIGENCE",
  "IDENTITY",
  "MULTI_TENANCY"
];
for (const domain of requiredDomains) {
  if (kernelSource.includes(`"${domain}"`)) {
    pass(`Enterprise Fabric domain ${domain}`);
  } else {
    fail(`missing Enterprise Fabric domain ${domain}`);
  }
}

const cargoToml = read("runtime/Cargo.toml");
if (cargoToml.includes('"crates/nexus-kernel"') && cargoToml.includes('nexus-kernel = { path = "crates/nexus-kernel" }')) {
  pass("Rust Kernel crate is a workspace member and dependency alias");
} else {
  fail("Rust Kernel crate must be registered in the runtime workspace");
}

const kernelCargo = read("runtime/crates/nexus-kernel/Cargo.toml");
const dependencySection = kernelCargo.split("[dependencies]")[1]?.trim() ?? "";
if (dependencySection === "") {
  pass("Rust Kernel has zero dependencies");
} else {
  fail("Rust Kernel must have zero dependencies");
}

const rustKernel = read("runtime/crates/nexus-kernel/src/lib.rs");
const forbiddenRust = ["EdgeTask", "nexus_policy", "nexus_agent", "nexus_edge_protocol", "tokio", "serde", "wasmtime"];
const rustBoundaryFailures = failures;
for (const forbidden of forbiddenRust) {
  if (rustKernel.includes(forbidden)) {
    fail(`Rust Kernel contains forbidden coupling ${forbidden}`);
  }
}
if (failures === rustBoundaryFailures) {
  pass("Rust Kernel avoids edge/policy/adapter coupling");
}

const plan = read("NEXUS_V7_ARCHITECTURE_PLAN.md");
if (
  plan.includes("NEXUS V7 is **CLOSED for foundation/architecture scope**") &&
  plan.includes("BENCHMARKED | NOT ACHIEVED") &&
  plan.includes("OPERATIONALLY_EVIDENCED | NOT ACHIEVED") &&
  plan.includes("PRODUCTION_PROVEN | NOT ACHIEVED") &&
  plan.includes("SPEC_ONLY")
) {
  pass("V7 plan separates architecture closure from unachieved later maturity states");
} else {
  fail("V7 plan must scope architecture closure and keep later maturity claims explicitly unachieved");
}

if (failures > 0) {
  console.error(`V7 architecture gates: ${failures} failure(s)`);
  process.exit(1);
}

console.log("V7 architecture gates: all executable static gates PASS");
