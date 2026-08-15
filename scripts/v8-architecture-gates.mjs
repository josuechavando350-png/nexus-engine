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

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

const artifacts = [
  "NEXUS_V8_ARCHITECTURE_PLAN.md",
  "docs/architecture/V8_BASELINE_AUDIT.md",
  "docs/evidence/NEXUS_V8_BENCHMARK_PLAN.md"
];

for (const artifact of artifacts) {
  if (existsSync(join(root, artifact))) pass(`artifact ${artifact}`);
  else fail(`missing artifact ${artifact}`);
}

if (failures === 0) {
  const architecture = read(artifacts[0]);
  const baseline = read(artifacts[1]);
  const benchmarks = read(artifacts[2]);
  const combined = `${architecture}\n${baseline}\n${benchmarks}`;
  const requiredCapabilities = [
    "Art Direction Engine",
    "Creative Vault",
    "Art Direction Memory",
    "Shader primitives",
    "Gesture / interaction primitives",
    "GPU Governor",
    "Benchmark framework"
  ];

  for (const capability of requiredCapabilities) {
    if (architecture.includes(capability) && baseline.includes(capability)) {
      pass(`V8 capability planned and audited: ${capability}`);
    } else {
      fail(`V8 capability missing from architecture or baseline: ${capability}`);
    }
  }

  const claimFailures = failures;
  for (const claim of [
    /\|[^\n]+\|\s*BENCHMARKED\s*\|/,
    /\|[^\n]+\|\s*OPERATIONALLY_EVIDENCED\s*\|/,
    /\|[^\n]+\|\s*PRODUCTION_PROVEN\s*\|/
  ]) {
    if (claim.test(combined)) fail(`V8 baseline contains unsupported maturity claim ${claim}`);
  }
  if (failures === claimFailures) pass("V8 baseline makes no unsupported maturity claims");

  if (
    architecture.includes("V7 remains closed") &&
    architecture.includes("V9 is not started") &&
    architecture.includes("V8.1/V8.2")
  ) {
    pass("V8 scope preserves V7 and excludes V8 subversions and V9");
  } else {
    fail("V8 scope must preserve V7 and exclude V8 subversions and V9");
  }

  if (
    architecture.includes("SPEC_ONLY") &&
    architecture.includes("No Rust crate is planned for V8 Experience") &&
    baseline.includes("No Experience package depends on the Rust workspace")
  ) {
    pass("V8 remains isolated from Industrial and preserves SPEC_ONLY Fabric boundaries");
  } else {
    fail("V8 must remain isolated from Industrial and preserve SPEC_ONLY Fabric boundaries");
  }

  if (
    benchmarks.includes("Status: **PLAN ONLY / NOT MEASURED**") &&
    benchmarks.includes("real measurements and raw results") &&
    benchmarks.includes("Do not force NEXUS to win")
  ) {
    pass("V8 benchmark plan requires real, fair, stored evidence");
  } else {
    fail("V8 benchmark plan must require real, fair, stored evidence");
  }
}

if (failures > 0) {
  console.error(`V8 architecture gates: ${failures} failure(s)`);
  process.exit(1);
}

console.log("V8 architecture gates: baseline architecture PASS");
