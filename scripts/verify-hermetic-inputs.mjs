import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";

const root = process.cwd();
for (const required of ["pnpm-lock.yaml", "runtime/Cargo.lock"]) {
  if (!existsSync(join(root, required))) throw new Error(`required frozen lockfile missing: ${required}`);
}

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .sort((a, b) => a.localeCompare(b, "en"));
const trackedSet = new Set(tracked.map((path) => normalize(path)));
const sourceExtensions = new Set([".css", ".scss", ".sass", ".less", ".html", ".tsx", ".jsx", ".ts", ".js", ".mjs"]);
const cssExtensions = new Set([".css", ".scss", ".sass", ".less"]);
const remoteFontHosts = /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.adobe\.com/i;
const cssUrl = /url\((['"]?)([^)'"\s]+)\1\)/g;
const fontExtensions = new Set([".woff", ".woff2", ".ttf", ".otf"]);

for (const relativePath of tracked) {
  const extension = extname(relativePath);
  if (!sourceExtensions.has(extension)) continue;
  const absolute = join(root, relativePath);
  const text = readFileSync(absolute, "utf8");
  if (remoteFontHosts.test(text) || text.includes("next/font/google")) throw new Error(`remote font provider forbidden in hermetic build: ${relativePath}`);

  if (!cssExtensions.has(extension)) continue;
  const containsFontFace = text.toLowerCase().includes("@font-face");
  for (const match of text.matchAll(cssUrl)) {
    const original = match[2];
    const raw = original.split("?")[0].split("#")[0];
    const remote = raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("//");
    if (containsFontFace && remote) throw new Error(`remote @font-face asset forbidden in hermetic build: ${relativePath} -> ${original}`);
    if (raw.startsWith("data:") || remote || !fontExtensions.has(extname(raw))) continue;
    const resolved = resolve(dirname(absolute), raw);
    const fontRelative = normalize(relative(root, resolved));
    if (!existsSync(resolved)) throw new Error(`referenced font asset is missing: ${relativePath} -> ${raw}`);
    if (!trackedSet.has(fontRelative)) throw new Error(`font asset must be versioned in git: ${fontRelative}`);
  }
}

console.log(`NEXUS hermetic input policy passed for ${tracked.length} tracked file(s).`);
