#!/usr/bin/env node
/**
 * NEXUS V3 Architecture Gates
 *
 * Static, dependency-free checks over the Rust runtime and the boundary
 * between the Experience plane (V2) and the Industrial Agentic plane (V3).
 *
 * These gates exist because the architectural rules of V3 are not the kind of
 * thing a compiler checks: "the ontology must not know about Neo4j" is true
 * or false about source text, not about types. They run with plain `node`,
 * with no npm install, so they execute in any environment including one with
 * no network and no Rust toolchain.
 *
 * What this is NOT: a substitute for `cargo build`, `cargo clippy` or
 * `cargo test`. It cannot prove the Rust compiles. Gates that require the
 * Rust toolchain report NOT TESTED here and are executed by
 * .github/workflows/rust.yml.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, extname } from "node:path";

const root = process.cwd();
const runtimeDir = join(root, "runtime");
const results = [];

function report(gate, status, detail) {
  results.push({ gate, status, detail });
}

function walk(dir, filter = () => true, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "target", ".next", ".git", "dist", "coverage"].includes(entry.name)) {
        continue;
      }
      walk(full, filter, acc);
    } else if (filter(full)) {
      acc.push(full);
    }
  }
  return acc;
}

const rustFiles = walk(runtimeDir, (p) => extname(p) === ".rs");
const rustSources = new Map(rustFiles.map((p) => [p, readFileSync(p, "utf8")]));

/**
 * Strips line comments, block comments and string/char literals so that a
 * pattern search sees code rather than prose. Without this, every gate below
 * would trip on its own documentation.
 */
function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  let state = "code";
  let blockDepth = 0;
  let rawHashes = 0;

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        blockDepth = 1;
        i += 2;
        continue;
      }
      if (c === "r" && (next === '"' || next === "#")) {
        let j = i + 1;
        let hashes = 0;
        while (source[j] === "#") {
          hashes++;
          j++;
        }
        if (source[j] === '"') {
          state = "raw";
          rawHashes = hashes;
          i = j + 1;
          continue;
        }
      }
      if (c === '"') {
        state = "string";
        i += 1;
        continue;
      }
      if (c === "'") {
        // Lifetime (e.g. 'a) vs char literal ('x'). Lifetimes are code.
        const isChar = source[i + 2] === "'" || (next === "\\" && source[i + 3] === "'");
        if (isChar) {
          state = "char";
          i += 1;
          continue;
        }
      }
      out += c;
      i += 1;
      continue;
    }

    if (state === "line") {
      if (c === "\n") {
        out += "\n";
        state = "code";
      }
      i += 1;
      continue;
    }

    if (state === "block") {
      if (c === "/" && next === "*") {
        blockDepth++;
        i += 2;
        continue;
      }
      if (c === "*" && next === "/") {
        blockDepth--;
        i += 2;
        if (blockDepth === 0) state = "code";
        continue;
      }
      if (c === "\n") out += "\n";
      i += 1;
      continue;
    }

    if (state === "string") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') state = "code";
      if (c === "\n") out += "\n";
      i += 1;
      continue;
    }

    if (state === "char") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "'") state = "code";
      i += 1;
      continue;
    }

    if (state === "raw") {
      if (c === '"') {
        let j = i + 1;
        let hashes = 0;
        while (source[j] === "#" && hashes < rawHashes) {
          hashes++;
          j++;
        }
        if (hashes === rawHashes) {
          state = "code";
          i = j;
          continue;
        }
      }
      if (c === "\n") out += "\n";
      i += 1;
      continue;
    }
  }

  return out;
}

const rustCode = new Map([...rustSources].map(([p, s]) => [p, stripCommentsAndStrings(s)]));

/* ------------------------------------------------------------------ */
/* Gate 1 — no React/Next/TypeScript inside the Rust runtime           */
/* ------------------------------------------------------------------ */
(function noFrontendInRuntime() {
  const problems = [];

  const webFiles = walk(runtimeDir, (p) =>
    [".ts", ".tsx", ".jsx", ".js", ".mjs", ".cjs", ".css"].includes(extname(p)),
  );
  for (const file of webFiles) {
    problems.push(`web asset inside runtime: ${relative(root, file)}`);
  }

  const forbidden = [/\breact\b/i, /\bnext\.js\b/i, /\buse client\b/, /\bjsx\b/i, /\btailwind\b/i];
  for (const [file, code] of rustCode) {
    for (const pattern of forbidden) {
      if (pattern.test(code)) {
        problems.push(`${relative(root, file)} references ${pattern}`);
      }
    }
  }

  const manifests = walk(runtimeDir, (p) => p.endsWith("Cargo.toml"));
  for (const manifest of manifests) {
    const text = readFileSync(manifest, "utf8");
    if (/\bnapi\b|\bwasm-bindgen\b|\bneon\b/.test(text)) {
      problems.push(`${relative(root, manifest)} bridges into the JS ecosystem`);
    }
  }

  report(
    "V3 Rust/Frontend separation",
    problems.length ? "FAIL" : "PASS",
    problems.length
      ? problems.join("; ")
      : `${rustFiles.length} Rust files contain no React/Next/TS coupling and no JS bridge dependency`,
  );
})();

/* ------------------------------------------------------------------ */
/* Gate 2 — Core/Experience must not depend on the runtime             */
/* ------------------------------------------------------------------ */
(function noCoreDependencyOnRuntime() {
  const problems = [];
  const tsFiles = [
    ...walk(join(root, "packages"), (p) => [".ts", ".tsx"].includes(extname(p))),
    ...walk(join(root, "apps"), (p) => [".ts", ".tsx"].includes(extname(p))),
  ];

  for (const file of tsFiles) {
    const text = readFileSync(file, "utf8");
    if (/from\s+["'].*\/runtime\//.test(text) || /require\(["'].*\/runtime\//.test(text)) {
      problems.push(`${relative(root, file)} imports from the Rust runtime tree`);
    }
  }

  for (const pkg of ["packages/core/package.json", "packages/experience/package.json"]) {
    const full = join(root, pkg);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, "utf8");
    if (/runtime|cargo|rust/i.test(text)) {
      problems.push(`${pkg} references the runtime`);
    }
  }

  report(
    "V3 plane independence",
    problems.length ? "FAIL" : "PASS",
    problems.length
      ? problems.join("; ")
      : "@nexus/core and @nexus/experience have no dependency on the Rust runtime",
  );
})();

/* ------------------------------------------------------------------ */
/* Gate 3 — the ontology must not couple to a graph database           */
/* ------------------------------------------------------------------ */
(function noGraphCouplingInOntology() {
  const problems = [];
  const ontologyFiles = [...rustCode].filter(([p]) =>
    p.includes(join("crates", "nexus-ontology")),
  );

  const forbidden = [
    /neo4j/i,
    /neo4rs/i,
    /memgraph/i,
    /\bcypher\b/i,
    /\bbolt:\/\//i,
    /\bMERGE\s*\(/,
    /\bMATCH\s*\(/,
    /\bCREATE\s+CONSTRAINT\b/i,
  ];

  for (const [file, code] of ontologyFiles) {
    for (const pattern of forbidden) {
      if (pattern.test(code)) {
        problems.push(`${relative(root, file)} matches ${pattern}`);
      }
    }
  }

  const manifest = join(runtimeDir, "crates/nexus-ontology/Cargo.toml");
  if (existsSync(manifest)) {
    const text = readFileSync(manifest, "utf8");
    if (/neo4rs|neo4j|memgraph|nexus-graph/i.test(text)) {
      problems.push("nexus-ontology/Cargo.toml depends on a graph backend");
    }
  }

  report(
    "V3 ontology decoupling",
    problems.length ? "FAIL" : "PASS",
    problems.length
      ? problems.join("; ")
      : `nexus-ontology (${ontologyFiles.length} files) names no database, driver or query language`,
  );
})();

/* ------------------------------------------------------------------ */
/* Gate 4 — no arbitrary edge payload execution                        */
/* ------------------------------------------------------------------ */
(function noArbitraryEdgeExecution() {
  const problems = [];
  const edgeFiles = [...rustCode].filter(
    ([p]) => p.includes("nexus-edge-protocol") || p.includes("nexus-edge-wasm"),
  );

  const forbidden = [
    /std::process::Command/,
    /\bunsafe\b/,
    /libloading/,
    /dlopen/,
    /transmute/,
    /from_raw_parts/,
  ];

  for (const [file, code] of edgeFiles) {
    for (const pattern of forbidden) {
      if (pattern.test(code)) {
        problems.push(`${relative(root, file)} matches ${pattern}`);
      }
    }
  }

  // Every crate in the runtime must forbid unsafe at the crate root.
  const libRoots = rustFiles.filter((p) => p.endsWith(join("src", "lib.rs")));
  for (const file of libRoots) {
    if (!/#!\[forbid\(unsafe_code\)\]/.test(rustSources.get(file))) {
      problems.push(`${relative(root, file)} does not forbid unsafe_code`);
    }
  }

  report(
    "V3 edge execution safety",
    problems.length ? "FAIL" : "PASS",
    problems.length
      ? problems.join("; ")
      : `${libRoots.length} crate roots forbid unsafe_code; no process spawn, dynamic loading or raw-pointer escape in the edge path`,
  );
})();

/* ------------------------------------------------------------------ */
/* Gate 5 — weapon and human-targeting prohibitions are present        */
/* ------------------------------------------------------------------ */
(function safetyInvariantsIntact() {
  const problems = [];
  const invariantsPath = join(runtimeDir, "crates/nexus-policy/src/invariants.rs");

  if (!existsSync(invariantsPath)) {
    report("V3 safety invariants", "FAIL", "nexus-policy/src/invariants.rs is missing");
    return;
  }

  const source = readFileSync(invariantsPath, "utf8");
  const required = [
    "NoWeaponCapability",
    "NoHumanTargeting",
    "NoExpiredCommand",
    "NoUnknownSigner",
    "NoReplayedNonce",
    "NoUnsupportedCapability",
    "NoHighImpactWithoutApproval",
  ];
  for (const invariant of required) {
    if (!source.includes(invariant)) problems.push(`hard invariant ${invariant} is missing`);
  }

  const requiredTerms = ["weapon", "targeting", "lethal", "munition", "fire_control"];
  for (const term of requiredTerms) {
    if (!source.includes(`"${term}"`)) {
      problems.push(`forbidden-term list no longer contains "${term}"`);
    }
  }

  const listMatch = source.match(
    /FORBIDDEN_CAPABILITY_SUBSTRINGS[^=]*=\s*&\[([\s\S]*?)\];/,
  );
  const termCount = listMatch ? (listMatch[1].match(/"/g) || []).length / 2 : 0;
  if (termCount < 20) {
    problems.push(`forbidden-term list has only ${termCount} entries; expected at least 20`);
  }

  // The detection class set must stay closed and must not gain a person class.
  const detectionPath = join(runtimeDir, "crates/nexus-event/src/detection.rs");
  if (existsSync(detectionPath)) {
    const detection = stripCommentsAndStrings(readFileSync(detectionPath, "utf8"));
    if (/\bOther\s*\(/.test(detection) || /_\s*=>\s*DetectionClass::/.test(detection)) {
      problems.push("DetectionClass has an open fallback variant");
    }
  }

  report(
    "V3 safety invariants",
    problems.length ? "FAIL" : "PASS",
    problems.length
      ? problems.join("; ")
      : `${required.length} hard invariants present, ${termCount} prohibited terms enforced, detection class set is closed`,
  );
})();

/* ------------------------------------------------------------------ */
/* Gate 6 — no hardcoded secrets, brokers or credentials               */
/* ------------------------------------------------------------------ */
(function noHardcodedSecrets() {
  const problems = [];
  const assignment =
    /(password|passwd|secret|api_key|apikey|access_token|private_key|credential)\s*[:=]\s*"([^"]{3,})"/gi;

  for (const [file, source] of rustSources) {
    
    let match;
    const pattern = new RegExp(assignment.source, "gi");
    while ((match = pattern.exec(source)) !== null) {
      const value = match[2];
      // Environment variable names and empty defaults are not secrets.
      const isEnvName = /^NEXUS_[A-Z0-9_]+$/.test(value);
      const isPlaceholder = /^(\$\{|<|change-me|example|redacted)/i.test(value);
      if (!isEnvName && !isPlaceholder) {
        problems.push(`${relative(root, file)}: literal ${match[1]}`);
      }
    }
  }

  // Broker and database endpoints must not be baked in outside config defaults.
  for (const [file, code] of rustCode) {
    const isConfig =
      file.includes("config.rs") || file.includes("neo4j.rs") || file.includes("kafka.rs");
    const endpoints = code.match(/"(bolt|kafka|redpanda|postgres|mysql):\/\/[^"]*"/g) || [];
    if (endpoints.length && !isConfig) {
      problems.push(`${relative(root, file)}: hardcoded endpoint ${endpoints[0]}`);
    }
  }

  if (!existsSync(join(runtimeDir, ".env.example"))) {
    problems.push("runtime/.env.example is missing");
  }

  const envFiles = walk(runtimeDir, (p) => p.endsWith(".env") || p.endsWith(".env.local"));
  for (const file of envFiles) {
    problems.push(`committed environment file: ${relative(root, file)}`);
  }

  report(
    "V3 secret hygiene",
    problems.length ? "FAIL" : "PASS",
    problems.length
      ? problems.join("; ")
      : "no literal credentials, no committed .env, configuration is environment-driven with .env.example present",
  );
})();

/* ------------------------------------------------------------------ */
/* Gate 7 — no false hardware/physical security claim                  */
/* ------------------------------------------------------------------ */
(function noFakeHardwareClaim() {
  const problems = [];
  const docs = [
    ...walk(join(root, "docs"), (p) => extname(p) === ".md"),
    ...walk(runtimeDir, (p) => extname(p) === ".md"),
  ];
  const sources = [...rustSources.values()];

  // Claims that would be false for a software gateway.
  const falseClaims = [
    /physically\s+(guarantee|enforce|prevent)/i,
    /hardware\s+data\s+diode/i,
    /guarantees?\s+physical\s+unidirectional/i,
    /is\s+a\s+data\s+diode/i,
    /air[- ]gapped\s+by\s+(this\s+)?software/i,
    /exactly[- ]once\s+(end[- ]to[- ]end|guaranteed)/i,
    /certified\s+(to\s+)?(IEC|SIL|DO-178)/i,
  ];

  const checkText = (label, text) => {
    for (const pattern of falseClaims) {
      const match = text.match(pattern);
      if (!match) continue;
      // A sentence that explicitly denies the claim is the correct form.
      const index = match.index ?? 0;
      const window = text.slice(Math.max(0, index - 220), index + 220);
      const denied =
        /\bnot\b|\bnever\b|\bcannot\b|\bdoes not\b|\bis no\b|\bwithout\b|\bno\b/i.test(window);
      if (!denied) problems.push(`${label}: unsupported claim "${match[0]}"`);
    }
  };

  for (const doc of docs) checkText(relative(root, doc), readFileSync(doc, "utf8"));
  for (const [file, source] of rustSources) checkText(relative(root, file), source);
  void sources;

  // The one-way crate must state the limitation explicitly.
  const oneway = join(runtimeDir, "crates/nexus-oneway/src/lib.rs");
  if (existsSync(oneway)) {
    const text = readFileSync(oneway, "utf8");
    if (!/not a (physical )?data diode|is not a data diode|no.{0,40}physical/i.test(text)) {
      problems.push("nexus-oneway does not state that software is not a physical data diode");
    }
  }

  report(
    "V3 honest security claims",
    problems.length ? "FAIL" : "PASS",
    problems.length
      ? problems.join("; ")
      : `${docs.length} documents and ${rustSources.size} sources make no unsupported physical-isolation, exactly-once or certification claim`,
  );
})();

/* ------------------------------------------------------------------ */
/* Gate 8 — Cargo workspace integrity                                  */
/* ------------------------------------------------------------------ */
(function workspaceIntegrity() {
  const problems = [];
  const workspaceManifest = join(runtimeDir, "Cargo.toml");

  if (!existsSync(workspaceManifest)) {
    report("V3 workspace integrity", "FAIL", "runtime/Cargo.toml is missing");
    return;
  }

  const text = readFileSync(workspaceManifest, "utf8");
  const membersBlock = text.match(/members\s*=\s*\[([\s\S]*?)\]/);
  const members = membersBlock
    ? [...membersBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : [];

  if (!members.length) problems.push("workspace declares no members");

  for (const member of members) {
    const manifest = join(runtimeDir, member, "Cargo.toml");
    if (!existsSync(manifest)) {
      problems.push(`member ${member} has no Cargo.toml`);
      continue;
    }
    const srcDir = join(runtimeDir, member, "src");
    if (!existsSync(srcDir)) problems.push(`member ${member} has no src/`);
  }

  // Every crate directory on disk must be a declared member.
  for (const group of ["crates", "services", "examples"]) {
    const dir = join(runtimeDir, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relPath = `${group}/${entry.name}`;
      if (!members.includes(relPath)) {
        problems.push(`${relPath} exists on disk but is not a workspace member`);
      }
    }
  }

  // Each crate that uses another nexus crate must declare it.
  for (const member of members) {
    const manifestPath = join(runtimeDir, member, "Cargo.toml");
    if (!existsSync(manifestPath)) continue;
    const manifest = readFileSync(manifestPath, "utf8");
    const srcFiles = walk(join(runtimeDir, member, "src"), (p) => extname(p) === ".rs");
    const used = new Set();
    for (const file of srcFiles) {
      const code = rustCode.get(file) ?? "";
      for (const match of code.matchAll(/\bnexus_([a-z_]+)\s*::/g)) {
        used.add(`nexus-${match[1].replace(/_/g, "-")}`);
      }
    }
    for (const crate of used) {
      const selfName = member.split("/").pop();
      if (crate === selfName) continue;
      if (!manifest.includes(crate)) {
        problems.push(`${member} uses ${crate} but does not declare it`);
      }
    }
  }

  report(
    "V3 workspace integrity",
    problems.length ? "FAIL" : "PASS",
    problems.length
      ? problems.join("; ")
      : `${members.length} workspace members declared, present on disk, with dependencies declared`,
  );
})();

/* ------------------------------------------------------------------ */
/* Gate 9 — Rust module wiring and source hygiene                      */
/* ------------------------------------------------------------------ */
(function rustSourceHygiene() {
  const problems = [];

  // 9a. Every `mod x;` resolves to a file, and every file is declared.
  for (const [file, code] of rustCode) {
    if (!file.endsWith("lib.rs") && !file.endsWith("main.rs")) continue;
    const dir = file.slice(0, file.lastIndexOf("/"));
    const declared = new Set();
    for (const match of code.matchAll(/^\s*(?:pub\s+)?mod\s+([a-z_0-9]+)\s*;/gm)) {
      declared.add(match[1]);
      const candidate = join(dir, `${match[1]}.rs`);
      const candidateDir = join(dir, match[1], "mod.rs");
      if (!existsSync(candidate) && !existsSync(candidateDir)) {
        problems.push(`${relative(root, file)} declares mod ${match[1]} with no source file`);
      }
    }
    for (const sibling of readdirSync(dir, { withFileTypes: true })) {
      if (!sibling.isFile() || extname(sibling.name) !== ".rs") continue;
      const stem = sibling.name.replace(/\.rs$/, "");
      if (["lib", "main"].includes(stem)) continue;
      if (!declared.has(stem)) {
        problems.push(`${relative(root, join(dir, sibling.name))} is not declared as a module`);
      }
    }
  }

  // 9b. Balanced delimiters. A mismatch is a certain compile error.
  for (const [file, code] of rustCode) {
    const counts = { "{": 0, "(": 0, "[": 0 };
    for (const c of code) {
      if (c === "{") counts["{"]++;
      else if (c === "}") counts["{"]--;
      else if (c === "(") counts["("]++;
      else if (c === ")") counts["("]--;
      else if (c === "[") counts["["]++;
      else if (c === "]") counts["["]--;
    }
    for (const [open, value] of Object.entries(counts)) {
      if (value !== 0) {
        problems.push(`${relative(root, file)}: unbalanced '${open}' (delta ${value})`);
      }
    }
  }

  // 9c. Unused top-level imports. clippy runs with -D warnings, so an unused
  // import is a build failure, not a nit.
  //
  // Traits are the exception that makes a naive check wrong: `use
  // std::io::Write;` is *required* for `writeln!` to resolve even though the
  // name `Write` never appears again. Every trait defined in this workspace is
  // collected, plus the external traits the adapters rely on, and those are
  // never reported.
  const traitNames = new Set([
    // std / core traits brought in for method resolution
    "Write", "Read", "BufRead", "Seek", "Iterator", "FromStr", "Display", "Debug",
    "Default", "Hash", "Hasher", "Deref", "DerefMut", "AsRef", "Borrow", "Error",
    // external traits used only behind optional features
    "Consumer", "Message", "Producer", "ProducerContext", "ClientContext",
    "FutureProducer", "StreamConsumer", "AsyncRuntime", "WasiView",
  ]);
  for (const code of rustCode.values()) {
    for (const match of code.matchAll(/\b(?:pub\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      traitNames.add(match[1]);
    }
  }

  for (const [file, code] of rustCode) {
    const lines = code.split("\n");
    for (const line of lines) {
      const match = line.match(/^use\s+([^;]+);/);
      if (!match) continue;
      const spec = match[1];
      if (spec.includes("*")) continue;
      const names = [];
      const braced = spec.match(/\{([^}]*)\}/);
      if (braced) {
        for (const part of braced[1].split(",")) {
          const name = part.trim().split(/\s+as\s+/).pop().trim();
          if (name && name !== "self") names.push(name);
        }
      } else {
        const name = spec.trim().split(/\s+as\s+/).pop().trim().split("::").pop();
        if (name) names.push(name);
      }
      const body = code.replace(line, "");
      for (const name of names) {
        if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        if (traitNames.has(name)) continue;
        const used = new RegExp(`\\b${name}\\b`).test(body);
        if (!used) {
          problems.push(`${relative(root, file)}: unused import '${name}'`);
        }
      }
    }
  }

  report(
    "V3 Rust source hygiene",
    problems.length ? "FAIL" : "PASS",
    problems.length
      ? problems.slice(0, 12).join("; ") + (problems.length > 12 ? ` (+${problems.length - 12} more)` : "")
      : `${rustFiles.length} files: module wiring resolves, delimiters balance, no unused top-level imports`,
  );
})();

/* ------------------------------------------------------------------ */
/* Gate 10 — cross-crate symbol resolution                             */
/* ------------------------------------------------------------------ */
(function crossCrateSymbols() {
  const problems = [];

  // Public surface of each workspace crate: items declared `pub`, plus every
  // leaf name re-exported from its lib.rs. Macro-generated types are covered
  // by the re-export scan, which is why both are needed.
  const crateSymbols = new Map();
  const crateModules = new Map();
  const cratesDir = join(runtimeDir, "crates");
  if (!existsSync(cratesDir)) {
    report("V3 cross-crate symbols", "NOT TESTED", "runtime/crates is missing");
    return;
  }

  for (const entry of readdirSync(cratesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const crateName = entry.name.replace(/-/g, "_");
    const symbols = new Set();
    const modules = new Set();
    const files = walk(join(cratesDir, entry.name, "src"), (p) => extname(p) === ".rs");

    for (const file of files) {
      const code = rustCode.get(file) ?? "";
      for (const match of code.matchAll(
        /\bpub(?:\s*\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?(struct|enum|trait|fn|const|static|type|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
      )) {
        symbols.add(match[2]);
        if (match[1] === "mod") modules.add(match[2]);
      }
      for (const match of code.matchAll(/\bpub\s+use\s+([^;]+);/g)) {
        const spec = match[1];
        const braced = spec.match(/\{([^}]*)\}/);
        if (braced) {
          for (const part of braced[1].split(",")) {
            const name = part.trim().split(/\s+as\s+/).pop().trim();
            if (name && name !== "self") symbols.add(name);
          }
        } else {
          const name = spec.trim().split(/\s+as\s+/).pop().trim().split("::").pop();
          if (name && name !== "*") symbols.add(name);
        }
      }
    }
    crateSymbols.set(crateName, symbols);
    crateModules.set(crateName, modules);
  }

  for (const [file, code] of rustCode) {
    for (const match of code.matchAll(/^use\s+(nexus_[a-z_]+)\s*::\s*([^;]+);/gm)) {
      const crate = match[1];
      const rest = match[2].trim();
      const symbols = crateSymbols.get(crate);
      if (!symbols) {
        problems.push(`${relative(root, file)}: unknown crate ${crate}`);
        continue;
      }
      if (rest.includes("*")) continue;

      // Path segments before the item must be declared modules. With no
      // braces the final segment is the item itself, not a module.
      const hasBraces = rest.includes("{");
      const rawPrefix = rest.split("{")[0].split("::").filter(Boolean).map((s) => s.trim());
      const pathPrefix = hasBraces ? rawPrefix : rawPrefix.slice(0, -1);
      const modules = crateModules.get(crate) ?? new Set();
      for (const segment of pathPrefix) {
        if (!/^[a-z_][a-z0-9_]*$/.test(segment)) continue;
        if (!modules.has(segment)) {
          problems.push(`${relative(root, file)}: ${crate}::${segment} is not a public module`);
        }
      }

      const names = [];
      const braced = rest.match(/\{([^}]*)\}/);
      if (braced) {
        for (const part of braced[1].split(",")) {
          const name = part.trim().split(/\s+as\s+/)[0].trim();
          if (name && name !== "self") names.push(name);
        }
      } else {
        const leaf = rest.split("::").pop().trim().split(/\s+as\s+/)[0].trim();
        if (leaf) names.push(leaf);
      }

      for (const name of names) {
        if (!/^[A-Z_][A-Za-z0-9_]*$/.test(name) && !/^[a-z_][a-z0-9_]*$/.test(name)) continue;
        if (modules.has(name)) continue;
        if (!symbols.has(name)) {
          problems.push(`${relative(root, file)}: ${crate}::${name} is not exported`);
        }
      }
    }
  }

  report(
    "V3 cross-crate symbols",
    problems.length ? "FAIL" : "PASS",
    problems.length
      ? problems.slice(0, 15).join("; ") + (problems.length > 15 ? ` (+${problems.length - 15} more)` : "")
      : `every nexus_* import resolves to an exported symbol across ${crateSymbols.size} crates`,
  );
})();

/* ------------------------------------------------------------------ */
/* Gate 11 — required V3 documentation and infrastructure              */
/* ------------------------------------------------------------------ */
(function requiredArtifacts() {
  const required = [
    "docs/architecture/V3_ARCHITECTURE.md",
    "docs/architecture/V3_DATA_PLANE.md",
    "docs/architecture/V3_ONTOLOGY.md",
    "docs/architecture/V3_ORCHESTRATION.md",
    "docs/architecture/V3_EDGE_RUNTIME.md",
    "docs/architecture/V3_ONEWAY_SECURITY.md",
    "docs/architecture/V3_PHYSICAL_AGENTS.md",
    "docs/security/V3_THREAT_MODEL.md",
    "docs/security/V3_TRUST_BOUNDARIES.md",
    "docs/research/V3_PERFORMANCE_TARGETS.md",
    "docs/research/V3_FAILURE_MODES.md",
    "runtime/README.md",
    "runtime/Cargo.toml",
    "runtime/deny.toml",
    "runtime/rust-toolchain.toml",
    "runtime/.env.example",
    "runtime/docker/docker-compose.yml",
  ];
  const missing = required.filter((path) => !existsSync(join(root, path)));

  report(
    "V3 required artifacts",
    missing.length ? "FAIL" : "PASS",
    missing.length
      ? `missing: ${missing.join(", ")}`
      : `${required.length} required V3 documents and infrastructure files present`,
  );
})();

/* ------------------------------------------------------------------ */
/* Gate 12 — Rust toolchain gates (cannot run without cargo)           */
/* ------------------------------------------------------------------ */
(function rustToolchainGates() {
    if (process.env.NEXUS_STATIC_ONLY === "1") {
    report(
      "Rust toolchain gates",
      "NOT TESTED",
      "static-only mode: Rust fmt/clippy/test/build are validated by dedicated CI jobs",
    );
    return;
    }
  const probe = spawnSync("cargo", ["--version"], { encoding: "utf8" });

  if (probe.error || probe.status !== 0) {
    report(
      "Rust toolchain gates",
      "NOT TESTED",
      "cargo is not available in this environment; fmt/clippy/test/build/audit/deny run in .github/workflows/rust.yml",
    );
    return;
  }

  const commands = [
    ["fmt", ["fmt", "--all", "--check"]],
    ["clippy", ["clippy", "--all-targets", "--all-features", "--", "-D", "warnings"]],
    ["test", ["test", "--workspace"]],
    ["build", ["build", "--workspace", "--release"]],
  ];
  const failures = [];
  for (const [label, args] of commands) {
    const result = spawnSync("cargo", args, { cwd: runtimeDir, encoding: "utf8" });
    if (result.status !== 0) {
      failures.push(`${label}: ${(result.stderr || "").split("\n").slice(0, 3).join(" | ")}`);
    }
  }
  report(
    "Rust toolchain gates",
    failures.length ? "FAIL" : "PASS",
    failures.length ? failures.join("; ") : "cargo fmt/clippy/test/build --release all exit 0",
  );
})();

/* ------------------------------------------------------------------ */

const width = Math.max(...results.map((result) => result.gate.length));
console.log("\nNEXUS V3 Architecture Gates\n" + "=".repeat(60));
for (const result of results) {
  console.log(`${result.gate.padEnd(width)}  [${result.status}]`);
  console.log(`  ${result.detail}\n`);
}

const failed = results.filter((result) => result.status === "FAIL");
const notTested = results.filter((result) => result.status === "NOT TESTED");
console.log(
  `${results.length} gates: ${results.filter((r) => r.status === "PASS").length} PASS, ` +
    `${failed.length} FAIL, ${notTested.length} NOT TESTED\n`,
);

process.exit(failed.length ? 1 : 0);
