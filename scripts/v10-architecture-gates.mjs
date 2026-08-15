import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
let failures = 0;
const pass = (message) => console.log(`PASS  ${message}`);
const fail = (message) => { failures += 1; console.error(`FAIL  ${message}`); };
const read = (path) => readFileSync(join(root, path), "utf8");

const architecturePath = "NEXUS_V10_ARCHITECTURE_PLAN.md";
const technologyPath = "docs/architecture/V10_TECHNOLOGY_EVALUATION.md";
const continuityPath = "docs/operations/V10_CONTINUITY_OPERABILITY_PLAN.md";
for (const path of [architecturePath, technologyPath, continuityPath]) {
  if (existsSync(join(root, path))) pass(`artifact ${path}`);
  else fail(`missing artifact ${path}`);
}

if (failures === 0) {
  const architecture = read(architecturePath);
  const technology = read(technologyPath);
  const continuity = read(continuityPath);

  const requiredArchitecture = [
    "Ontology Kernel",
    "Operational Domain",
    "Creative Domain",
    "Action and Policy Runtime",
    "Query and Persistence Ports",
    "AI Orchestration Boundary",
    "Private Creative Library",
    "Continuity, Operability and Transferability",
    "Cross-tenant and cross-organization access is denied by default",
    "Missing evidence is never equivalent to successful evidence",
    "Any undocumented critical recovery or deployment step is a V10 defect"
  ];
  for (const phrase of requiredArchitecture) {
    if (architecture.includes(phrase)) pass(`V10 architecture invariant: ${phrase}`);
    else fail(`missing V10 architecture invariant: ${phrase}`);
  }

  const forbiddenSplit = ["two products", "two engines glued together"];
  if (forbiddenSplit.every((phrase) => architecture.includes(phrase))) pass("V10 explicitly prevents operational/creative product split");
  else fail("V10 must explicitly prevent operational/creative product split");

  const requiredEvaluation = [
    "NO BACKEND SELECTED YET",
    "Palantir Foundry Ontology",
    "TypeDB / TypeQL",
    "Property-graph backend class",
    "Relational/PostgreSQL backend class",
    "replacement difficulty",
    "representative NEXUS workloads",
    "in-memory conformance adapter"
  ];
  for (const phrase of requiredEvaluation) {
    if (technology.includes(phrase)) pass(`V10 technology evaluation requirement: ${phrase}`);
    else fail(`missing V10 technology evaluation requirement: ${phrase}`);
  }

  const requiredContinuity = [
    "Bus-factor requirement",
    "clean-room operator",
    "backup and restore runbook",
    "disaster-recovery plan",
    "SBOM generation path",
    "AI is never a superuser",
    "IP and customer separation",
    "another qualified team can operate the engine without undocumented oral knowledge",
    "clean-room bootstrap and rollback evidence"
  ];
  for (const phrase of requiredContinuity) {
    if (continuity.includes(phrase)) pass(`V10 continuity invariant: ${phrase}`);
    else fail(`missing V10 continuity invariant: ${phrase}`);
  }

  if (/default backend only after benchmark artifacts/.test(technology)) pass("V10 backend adoption requires benchmark evidence");
  else fail("V10 backend adoption must require benchmark evidence");

  if (/vendor-neutral/.test(architecture) && /storage-neutral/.test(architecture)) pass("V10 Ontology Kernel remains vendor/storage neutral");
  else fail("V10 Ontology Kernel must remain vendor/storage neutral");

  if (architecture.includes("final Codex V1->V10 audit has no unresolved critical/high findings")) pass("V10 closure requires clean Codex V1->V10 audit");
  else fail("V10 closure must require Codex V1->V10 audit with no unresolved critical/high findings");
}

if (failures > 0) {
  console.error(`V10 architecture gates: ${failures} failure(s)`);
  process.exit(1);
}
console.log("V10 architecture gates: foundation PASS");
