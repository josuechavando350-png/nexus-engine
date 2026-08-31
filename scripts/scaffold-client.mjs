#!/usr/bin/env node
import { createHash } from "node:crypto";
import { basename, join, relative } from "node:path";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { addWorkspaceImporterFromSeed, assertClientSlug, compileProjectSources, parseProjectSpecification } from "./project-spec-contract.mjs";

function usage() {
  throw new Error("usage: node scripts/scaffold-client.mjs <kebab-case-name> --project-spec <json-path>");
}

const [rawName, specFlag, specPath, ...extra] = process.argv.slice(2);
if (!rawName || specFlag !== "--project-spec" || !specPath || extra.length) usage();
const name = assertClientSlug(rawName);
const root = process.cwd();
const source = join(root, "apps", "_experience-seed");
const target = join(root, "apps", name);
const lockfilePath = join(root, "pnpm-lock.yaml");
if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error("apps/_experience-seed is missing");
if (existsSync(target)) throw new Error(`target already exists: apps/${name}`);
if (!existsSync(lockfilePath) || !statSync(lockfilePath).isFile()) throw new Error("pnpm-lock.yaml is required for a client scaffold");

let parsed;
try { parsed = JSON.parse(readFileSync(specPath, "utf8")); }
catch (cause) { throw new Error("project specification is not valid JSON", { cause }); }
const spec = parseProjectSpecification(parsed, name);
const compiled = compileProjectSources(spec);
const originalLockfile = readFileSync(lockfilePath, "utf8");
const nextLockfile = addWorkspaceImporterFromSeed(originalLockfile, name);

const staging = mkdtempSync(join(root, "apps", `.nexus-scaffold-${name}-`));
const lockfileStaging = join(root, `.pnpm-lock.nexus-${name}-${process.pid}.yaml`);
let published = false;
const excluded = new Set([".next", "node_modules", "dist", "coverage", "tsconfig.tsbuildinfo"]);

const replaceTokens = (directory) => {
  for (const entry of readdirSync(directory).sort((a, b) => a.localeCompare(b, "en"))) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) replaceTokens(path);
    else if (stats.isFile()) {
      const bytes = readFileSync(path);
      if (!bytes.includes(0)) writeFileSync(path, bytes.toString("utf8").replaceAll("__NEXUS_CLIENT_SLUG__", name));
    }
  }
};

const walkFiles = (directory, output = []) => {
  for (const entry of readdirSync(directory).sort((a, b) => a.localeCompare(b, "en"))) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) walkFiles(path, output);
    else if (stats.isFile()) output.push(path);
  }
  return output;
};

try {
  cpSync(source, staging, {
    recursive: true,
    preserveTimestamps: false,
    filter: (path) => path === source || !excluded.has(basename(path)),
  });
  replaceTokens(staging);

  const packagePath = join(staging, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  packageJson.name = `@nexus/${name}`;
  packageJson.description = `NEXUS client experience for ${spec.business.name}`;
  packageJson.nexus = { clientProject: true, projectSpecDigest: compiled.specDigest };
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  mkdirSync(join(staging, ".nexus"), { recursive: true });
  writeFileSync(join(staging, ".nexus", "project-spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
  writeFileSync(join(staging, ".nexus", "compiled-project.json"), `${JSON.stringify(compiled.evidence, null, 2)}\n`);
  for (const [relativePath, content] of compiled.files.entries()) {
    const path = join(staging, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }

  const files = walkFiles(staging).filter((path) => relative(staging, path).replaceAll("\\", "/") !== ".nexus/scaffold-manifest.json");
  const manifest = files.map((path) => ({
    path: relative(staging, path).replaceAll("\\", "/"),
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  }));
  writeFileSync(join(staging, ".nexus", "scaffold-manifest.json"), `${JSON.stringify({
    authority: "NEXUS_SCAFFOLD_V2",
    client: name,
    projectSpecDigest: compiled.specDigest,
    compilerAuthority: compiled.evidence.authority,
    files: manifest,
  }, null, 2)}\n`);

  writeFileSync(lockfileStaging, nextLockfile);
  if (existsSync(target)) throw new Error(`target already exists: apps/${name}`);
  renameSync(staging, target);
  published = true;
  renameSync(lockfileStaging, lockfilePath);
  console.log(`scaffolded apps/${name} from ${compiled.specDigest}`);
} catch (cause) {
  if (published) rmSync(target, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
  rmSync(lockfileStaging, { force: true });
  throw cause;
}
