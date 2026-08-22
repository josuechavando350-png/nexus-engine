import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".html", ".css", ".scss"]);
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".svg", ".ico", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".woff", ".woff2", ".ttf", ".otf", ".pdf"]);
const IGNORE_DIRS = new Set(["node_modules", ".next", "dist", "build", "out", ".git", ".nexus-cache", "coverage"]);

const normalize = (value) => value.split(sep).join("/");

function walkTextFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path);
    }
  };
  visit(root);
  return files;
}

function stripQueryAndHash(value) {
  return value.split("#", 1)[0].split("?", 1)[0];
}

export function declaredPublicAssets(appDir) {
  const publicDir = join(appDir, "public");
  const declarations = [];
  const quoted = /(["'`])([^"'`\n\r]+)\1/g;
  for (const sourceFile of walkTextFiles(appDir)) {
    if (normalize(sourceFile).includes("/public/")) continue;
    const text = readFileSync(sourceFile, "utf8");
    for (const match of text.matchAll(quoted)) {
      const raw = match[2].trim();
      if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("${")) continue;
      const clean = stripQueryAndHash(raw);
      if (!ASSET_EXTENSIONS.has(extname(clean).toLowerCase())) continue;
      const absolute = resolve(publicDir, `.${clean}`);
      if (!normalize(absolute).startsWith(`${normalize(resolve(publicDir))}/`) && absolute !== resolve(publicDir)) {
        throw new Error(`asset path escapes public directory: ${normalize(relative(appDir, sourceFile))} -> ${raw}`);
      }
      declarations.push({ sourceFile, raw, clean, absolute });
    }
  }
  return declarations.sort((a, b) => `${normalize(a.sourceFile)}\0${a.clean}`.localeCompare(`${normalize(b.sourceFile)}\0${b.clean}`, "en"));
}

export function verifyAppAssets(appDir) {
  const declarations = declaredPublicAssets(appDir);
  const failures = [];
  for (const item of declarations) {
    if (!existsSync(item.absolute)) failures.push(`${normalize(relative(appDir, item.sourceFile))} -> ${item.raw} (missing)`);
    else {
      const stats = statSync(item.absolute);
      if (!stats.isFile()) failures.push(`${normalize(relative(appDir, item.sourceFile))} -> ${item.raw} (not a file)`);
      else if (stats.size <= 0) failures.push(`${normalize(relative(appDir, item.sourceFile))} -> ${item.raw} (empty)`);
    }
  }
  if (failures.length) throw new Error(`declared asset verification failed for ${normalize(appDir)}:\n${failures.map((value) => `- ${value}`).join("\n")}`);
  return { declarations: declarations.length, appDir: normalize(appDir) };
}

export function verifyWorkspaceAssets(root = process.cwd()) {
  const appsRoot = join(root, "apps");
  if (!existsSync(appsRoot)) throw new Error("apps directory is missing; client projects must live under apps/");
  const appDirs = readdirSync(appsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(appsRoot, entry.name))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .sort((a, b) => a.localeCompare(b, "en"));
  if (!appDirs.length) throw new Error("no app packages found under apps/");
  const results = appDirs.map(verifyAppAssets);
  const declarations = results.reduce((sum, item) => sum + item.declarations, 0);
  console.log(`NEXUS asset guard passed: ${appDirs.length} app(s), ${declarations} declared public asset reference(s) verified.`);
  return results;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) verifyWorkspaceAssets();
