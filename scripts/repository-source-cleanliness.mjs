import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

const normalizePath = (value) => value.split(sep).join("/");

function git(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function normalizeAllowedRoot(repositoryRoot, candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) throw new Error("allowed untracked root must be a non-empty repository-relative path");
  if (isAbsolute(candidate)) throw new Error(`allowed untracked root must be repository-relative: ${candidate}`);
  const absolute = resolve(repositoryRoot, candidate);
  const rel = normalizePath(relative(repositoryRoot, absolute));
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../")) {
    throw new Error(`allowed untracked root escapes or equals repository root: ${candidate}`);
  }
  return rel.replace(/\/+$/u, "");
}

function isWithinAllowedRoot(path, allowedRoots) {
  return allowedRoots.some((root) => path === root || path.startsWith(`${root}/`));
}

export function inspectRepositorySourceCleanliness(repositoryRoot, options = {}) {
  const root = resolve(repositoryRoot);
  const allowedRoots = Object.freeze((options.allowedUntrackedRoots ?? []).map((candidate) => normalizeAllowedRoot(root, candidate)));

  // Tracked files are source-of-truth and may never be dirty. Keep this check
  // independent from untracked evidence so a generated artifact cannot mask a
  // real edit to code/configuration.
  const trackedStatus = git(root, ["status", "--porcelain=v1", "--untracked-files=no", "-z"]);
  const trackedChanges = Object.freeze(trackedStatus.split("\0").filter(Boolean));

  // Inspect every non-ignored untracked file explicitly. Only caller-declared
  // generated evidence roots may coexist with an otherwise pristine source
  // checkout. Prefix matching is path-segment aware ("artifacts-x" is not
  // inside "artifacts").
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .sort((a, b) => a.localeCompare(b, "en"));
  const allowedUntrackedPaths = Object.freeze(untracked.filter((path) => isWithinAllowedRoot(path, allowedRoots)));
  const disallowedUntrackedPaths = Object.freeze(untracked.filter((path) => !isWithinAllowedRoot(path, allowedRoots)));

  return Object.freeze({
    clean: trackedChanges.length === 0 && disallowedUntrackedPaths.length === 0,
    trackedChanges,
    allowedUntrackedPaths,
    disallowedUntrackedPaths,
  });
}

export function assertRepositorySourceClean(repositoryRoot, options = {}) {
  const inspection = inspectRepositorySourceCleanliness(repositoryRoot, options);
  if (inspection.clean) return inspection;

  const details = [];
  if (inspection.trackedChanges.length) details.push(`tracked changes: ${inspection.trackedChanges.join(", ")}`);
  if (inspection.disallowedUntrackedPaths.length) details.push(`untracked source paths: ${inspection.disallowedUntrackedPaths.join(", ")}`);
  throw new Error(`${options.context ?? "repository source"} is not clean (${details.join("; ")})`);
}
