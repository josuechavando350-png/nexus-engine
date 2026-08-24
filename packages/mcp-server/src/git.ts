import type { GitState } from "./contracts.js";
import { runReadOnly } from "./process.js";

export async function readGitState(root: string): Promise<GitState> {
  const [headSha, branchValue, porcelain, remoteUrl] = await Promise.all([
    runReadOnly("git", ["rev-parse", "HEAD"], root),
    runReadOnly("git", ["branch", "--show-current"], root),
    runReadOnly("git", ["status", "--porcelain=v1", "-z"], root),
    runReadOnly("git", ["config", "--get", "remote.origin.url"], root).catch(() => ""),
  ]);
  if (!/^[a-f0-9]{40}$/.test(headSha)) throw new Error("git returned an invalid HEAD SHA");
  const changedPaths = porcelain
    ? porcelain.split("\0").filter(Boolean).map((line) => line.slice(3)).sort((a, b) => a.localeCompare(b, "en"))
    : [];
  return Object.freeze({
    branch: branchValue || "HEAD",
    headSha,
    detached: !branchValue,
    clean: changedPaths.length === 0,
    changedPaths: Object.freeze(changedPaths),
    remoteUrl: remoteUrl || null,
  });
}
