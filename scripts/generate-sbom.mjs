import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const JSON_COMMAND_MAX_BUFFER = 32 * 1024 * 1024;
const runJson = (command, args, cwd = root) => JSON.parse(execFileSync(command, args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  maxBuffer: JSON_COMMAND_MAX_BUFFER,
}));
const checkoutRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const revision = process.env.NEXUS_VALIDATED_SHA || checkoutRevision;
if (revision !== checkoutRevision) {
  throw new Error(`SBOM source SHA mismatch: NEXUS_VALIDATED_SHA=${revision} but checkout HEAD=${checkoutRevision}`);
}
if (!/^[a-f0-9]{40}$/i.test(revision)) throw new Error(`Invalid validated Git SHA: ${revision}`);

const components = new Map();
const add = (component) => {
  const key = `${component.type}:${component.name}@${component.version}`;
  if (!components.has(key)) components.set(key, component);
};

const pnpm = runJson("pnpm", ["list", "-r", "--json", "--depth", "Infinity"]);
const visitNode = (node) => {
  if (!node || typeof node !== "object") return;
  if (typeof node.name === "string" && typeof node.version === "string") {
    add({ type: "library", name: node.name, version: node.version, properties: [{ name: "nexus:ecosystem", value: "npm" }] });
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = node[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, value] of Object.entries(deps)) {
      if (value && typeof value === "object") visitNode({ name, ...value });
      else if (typeof value === "string") add({ type: "library", name, version: value, properties: [{ name: "nexus:ecosystem", value: "npm" }] });
    }
  }
};
for (const workspace of Array.isArray(pnpm) ? pnpm : [pnpm]) visitNode(workspace);

const cargoRoot = process.env.NEXUS_LOCK_WORKTREE || root;
const cargo = runJson("cargo", ["metadata", "--locked", "--format-version", "1", "--manifest-path", "runtime/Cargo.toml"], cargoRoot);
for (const pkg of cargo.packages ?? []) {
  add({
    type: "library",
    name: pkg.name,
    version: pkg.version,
    purl: `pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`,
    properties: [
      { name: "nexus:ecosystem", value: "cargo" },
      { name: "nexus:source", value: pkg.source ?? "workspace" },
    ],
  });
}

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: `urn:uuid:${revision.slice(0, 8)}-${revision.slice(8, 12)}-4${revision.slice(13, 16)}-8${revision.slice(17, 20)}-${revision.slice(20, 32)}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: "application", name: "nexus-engine", version: revision },
    properties: [
      { name: "nexus:git-sha", value: revision },
      { name: "nexus:identity-source", value: "validated-checkout-head" },
    ],
  },
  components: [...components.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en")),
};

const outDir = join(root, "artifacts", "security");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `nexus-${revision}.cdx.json`);
writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`, "utf8");
console.log(`CycloneDX SBOM written to ${out} with ${bom.components.length} components for validated source ${revision}`);
