import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
let failures = 0;

const pass = (message) => console.log(`PASS  ${message}`);
const fail = (message) => { failures += 1; console.error(`FAIL  ${message}`); };
const read = (path) => readFileSync(join(root, path), "utf8");

const artifacts = [
  "NEXUS_V9_ARCHITECTURE_PLAN.md",
  "docs/architecture/V9_BASELINE_AUDIT.md",
  "docs/evidence/NEXUS_V9_BENCHMARK_EXECUTION_PLAN.md",
  "docs/V8-CLOSURE.md"
];

for (const artifact of artifacts) {
  if (existsSync(join(root, artifact))) pass(`artifact ${artifact}`);
  else fail(`missing artifact ${artifact}`);
}

if (failures === 0) {
  const architecture = read(artifacts[0]);
  const baseline = read(artifacts[1]);
  const benchmark = read(artifacts[2]);
  const closure = read(artifacts[3]);
  const combined = `${architecture}\n${baseline}\n${benchmark}`;

  const capabilities = [
    "Measurement Harness",
    "Browser / Device Capture Port",
    "Benchmark Executor",
    "Visual Evidence Pipeline",
    "Runtime Telemetry Evidence",
    "Regression Governor",
    "Operational Evidence Port",
    "V9 Evidence Gates"
  ];

  for (const capability of capabilities) {
    if (architecture.includes(capability) && baseline.includes(capability)) pass(`V9 capability planned and audited: ${capability}`);
    else fail(`V9 capability missing from architecture or baseline: ${capability}`);
  }

  if (architecture.includes("V8 remains closed") && closure.includes("V8 is considered implementation-complete")) {
    pass("V9 preserves V8 closure boundary");
  } else {
    fail("V9 must explicitly preserve V8 closure boundary");
  }

  if (benchmark.includes("NO NEW V9 MEASUREMENTS YET") && benchmark.includes("raw samples") && benchmark.includes("Do not force NEXUS to win")) {
    pass("V9 benchmark execution plan distinguishes planned from measured evidence");
  } else {
    fail("V9 benchmark plan must distinguish planned from measured evidence and require raw samples");
  }

  const unsupportedClaims = [
    /\|[^\n]+\|\s*BENCHMARKED\s*\|/,
    /\|[^\n]+\|\s*OPERATIONALLY_EVIDENCED\s*\|/,
    /\|[^\n]+\|\s*PRODUCTION_PROVEN\s*\|/
  ];
  const before = failures;
  for (const pattern of unsupportedClaims) if (pattern.test(combined)) fail(`V9 baseline contains unsupported maturity claim ${pattern}`);
  if (failures === before) pass("V9 baseline makes no unsupported maturity claims");

  const rules = [
    "Missing evidence is never equivalent to PASS",
    "Cross-tenant and cross-brand evidence mixing is forbidden",
    "Backend technology remains replaceable through ports/adapters"
  ];
  for (const rule of rules) {
    if (architecture.includes(rule)) pass(`V9 invariant: ${rule}`);
    else fail(`missing V9 invariant: ${rule}`);
  }
}

if (failures > 0) {
  console.error(`V9 architecture gates: ${failures} failure(s)`);
  process.exit(1);
}

console.log("V9 architecture gates: foundation PASS");
