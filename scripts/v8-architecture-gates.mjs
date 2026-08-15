import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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

function filesUnder(path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [];
  const result = [];
  for (const entry of readdirSync(absolute)) {
    const child = join(absolute, entry);
    if (statSync(child).isDirectory()) result.push(...filesUnder(relative(root, child)));
    else result.push(relative(root, child));
  }
  return result;
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
    if (architecture.includes(capability) && baseline.includes(capability)) pass(`V8 capability planned and audited: ${capability}`);
    else fail(`V8 capability missing from architecture or baseline: ${capability}`);
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

  if (architecture.includes("V7 remains closed") && architecture.includes("V9 is not started") && architecture.includes("V8.1/V8.2")) {
    pass("V8 scope preserves V7 and excludes V8 subversions and V9");
  } else {
    fail("V8 scope must preserve V7 and exclude V8 subversions and V9");
  }

  if (architecture.includes("SPEC_ONLY") && architecture.includes("No Rust crate is planned for V8 Experience") && baseline.includes("No Experience package depends on the Rust workspace")) {
    pass("V8 remains isolated from Industrial and preserves SPEC_ONLY Fabric boundaries");
  } else {
    fail("V8 must remain isolated from Industrial and preserve SPEC_ONLY Fabric boundaries");
  }

  if (benchmarks.includes("Status: **PLAN ONLY / NOT MEASURED**") && benchmarks.includes("real measurements and raw results") && benchmarks.includes("Do not force NEXUS to win")) {
    pass("V8 benchmark plan requires real, fair, stored evidence");
  } else {
    fail("V8 benchmark plan must require real, fair, stored evidence");
  }
}

const creativeRequired = [
  "packages/creative/package.json",
  "packages/creative/shared.ts",
  "packages/creative/evidence/index.ts",
  "packages/creative/vault/index.ts",
  "packages/creative/memory/index.ts",
  "packages/creative/tests/vault.test.ts",
  "packages/creative/tests/memory.test.ts",
  "packages/creative/tests/evidence.test.ts",
  "packages/creative/tests/conformance.test.ts"
];

const anyCreative = creativeRequired.some((path) => existsSync(join(root, path)));
if (anyCreative) {
  for (const path of creativeRequired) {
    if (existsSync(join(root, path))) pass(`V8 implemented artifact ${path}`);
    else fail(`V8 implementation is partial; missing ${path}`);
  }

  const creativeSourceFiles = filesUnder("packages/creative").filter((path) => path.endsWith(".ts") && !path.includes("/tests/"));
  const source = creativeSourceFiles.map((path) => `\n// ${path}\n${read(path)}`).join("\n");
  const forbidden = [
    /from\s+["']react["']/i,
    /from\s+["']next(?:\/[^"']*)?["']/i,
    /from\s+["'](?:three|gsap|rive|@rive-app\/[^"']*|lottie[^"']*)["']/i,
    /runtime\/crates/i,
    /nexus-industrial/i,
    /services\/industrial/i,
    /\bwindow\b/,
    /\bdocument\b/,
    /\bHTMLElement\b/,
    /\bWebGLRenderingContext\b/,
    /\bGPUDevice\b/
  ];
  const boundaryFailures = failures;
  for (const pattern of forbidden) if (pattern.test(source)) fail(`@nexus/creative leaks forbidden framework/vendor/runtime/browser dependency: ${pattern}`);
  if (failures === boundaryFailures) pass("@nexus/creative remains framework-, vendor-, browser-, Rust-, and Industrial-neutral");

  const vault = read("packages/creative/vault/index.ts");
  if (vault.includes('version "latest" is forbidden') && vault.includes("lineage must anchor to manifest digest") && vault.includes("DIGEST_MISMATCH")) {
    pass("Creative Vault enforces immutable versioning and digest/lineage integrity");
  } else {
    fail("Creative Vault must enforce immutable versioning and digest/lineage integrity");
  }

  const memory = read("packages/creative/memory/index.ts");
  if (memory.includes('authority: "EVIDENCE_ONLY"') && memory.includes("mayFinalizeDirection: false") && memory.includes("SUPERSESSION_INCONSISTENT") && memory.includes("RETENTION_VIOLATION")) {
    pass("Art Direction Memory remains evidence-only with supersession and retention controls");
  } else {
    fail("Art Direction Memory must remain evidence-only with supersession and retention controls");
  }

  const evidence = read("packages/creative/evidence/index.ts");
  if (evidence.includes("scope.tenantId") && evidence.includes("scope.brandId") && evidence.includes("occurredAt") && evidence.includes('deliveryStatus: "FAILED"')) {
    pass("Creative evidence identity is scope/time aware and sink failure is explicit");
  } else {
    fail("Creative evidence must be scope/time aware with explicit sink failure semantics");
  }
}

if (failures > 0) {
  console.error(`V8 architecture gates: ${failures} failure(s)`);
  process.exit(1);
}

console.log(anyCreative ? "V8 architecture gates: baseline + Vault/Memory implementation PASS" : "V8 architecture gates: baseline architecture PASS");
