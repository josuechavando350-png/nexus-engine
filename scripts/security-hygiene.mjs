import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const roots = [
  "apps",
  "packages",
  "runtime/crates",
  "runtime/services",
  "runtime/examples",
  "scripts",
];

const textExtensions = new Set([
  ".rs", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".toml", ".yaml", ".yml", ".md"
]);

const skippedParts = new Set([
  "node_modules", "target", ".next", "dist", "coverage", ".git"
]);

const credentialPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["OpenAI API key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
];

const unfinishedPatterns = [
  ["todo! macro", /\btodo!\s*\(/],
  ["unimplemented! macro", /\bunimplemented!\s*\(/],
];

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skippedParts.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && textExtensions.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

const findings = [];

for (const root of roots) {
  for (const file of walk(path.join(ROOT, root))) {
    const rel = path.relative(ROOT, file);
    const content = fs.readFileSync(file, "utf8");

    for (const [name, regex] of credentialPatterns) {
      if (regex.test(content)) findings.push(`${rel}: possible ${name}`);
    }
    for (const [name, regex] of unfinishedPatterns) {
      if (regex.test(content)) findings.push(`${rel}: ${name}`);
    }
  }
}

const forbiddenEnvFiles = [".env", ".env.local", "runtime/.env"];
for (const rel of forbiddenEnvFiles) {
  if (fs.existsSync(path.join(ROOT, rel))) findings.push(`${rel}: secret-bearing env file is present`);
}

if (findings.length) {
  console.error("NEXUS security hygiene gate FAILED:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("NEXUS security hygiene gate passed.");
