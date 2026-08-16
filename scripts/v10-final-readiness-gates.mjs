import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
let failures = 0;
const pass = (message) => console.log(`PASS  ${message}`);
const fail = (message) => { failures += 1; console.error(`FAIL  ${message}`); };
const read = (path) => readFileSync(join(root, path), "utf8");

const requiredFiles = [
  "docs/audit/V10_FINAL_AUDIT_PLAN.md",
  "docs/operations/V10_CLEAN_ROOM_BOOTSTRAP.md",
  "docs/operations/V10_HANDOFF_PACKAGE.md",
  "docs/operations/V10_CONTINUITY_OPERABILITY_PLAN.md",
  "docs/operations/V10_TRANSFERABILITY_CHECKLIST.md"
];

for (const path of requiredFiles) {
  if (existsSync(join(root, path))) pass(`release artifact ${path}`);
  else fail(`missing release artifact ${path}`);
}

if (existsSync(join(root, "docs/audit/V10_FINAL_AUDIT_PLAN.md"))) {
  const audit = read("docs/audit/V10_FINAL_AUDIT_PLAN.md");
  const invariants = [
    "zero unresolved Critical or High findings",
    "full V3→V10 CI green on final integrated SHA",
    "clean-room bootstrap transcript",
    "backup/restore round-trip with integrity verification",
    "tenant isolation negative tests",
    "AI denied/direct-mutation negative tests",
    "supply-chain/SBOM evidence",
    "customer export/offboarding exercise",
    "final Codex V1→V10 audit report",
    "Undocumented oral knowledge is a release-blocking defect"
  ];
  for (const phrase of invariants) {
    if (audit.includes(phrase)) pass(`final audit invariant: ${phrase}`);
    else fail(`missing final audit invariant: ${phrase}`);
  }

  const forbiddenOverride = ["Feature count", "lines of code", "claimed speed", "strategic value"];
  if (forbiddenOverride.every((phrase) => audit.includes(phrase))) pass("evidence overrides valuation/feature claims");
  else fail("audit must explicitly prevent non-evidence release overrides");
}

if (failures > 0) {
  console.error(`V10 final readiness gates: ${failures} failure(s)`);
  process.exit(1);
}

console.log("V10 final readiness gates: PASS");
