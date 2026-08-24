import type { PullRequestCheck, PullRequestState } from "./contracts.js";

interface GithubOptions { repository: string; token: string; fetcher?: typeof fetch }
interface GithubPull { number: number; title: string; html_url: string; draft?: boolean; state: string; merged_at?: string | null; mergeable?: boolean | null; head: { ref: string; sha: string }; base: { ref: string } }
interface GithubCheck { name: string; status: string; conclusion: string | null; details_url?: string | null }

function checkStatus(check: GithubCheck): PullRequestCheck["status"] {
  if (check.status !== "completed") return "PENDING";
  if (["success", "neutral", "skipped"].includes(check.conclusion ?? "")) return "PASS";
  if (["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"].includes(check.conclusion ?? "")) return "FAIL";
  return "NOT_TESTED";
}

async function githubJson<T>(url: string, options: GithubOptions): Promise<T> {
  const response = await (options.fetcher ?? fetch)(url, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${options.token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText}`);
  return await response.json() as T;
}

export async function readOpenPullRequests(options: GithubOptions): Promise<readonly PullRequestState[]> {
  const base = `https://api.github.com/repos/${options.repository}`;
  const pulls = await githubJson<GithubPull[]>(`${base}/pulls?state=open&per_page=100`, options);
  return await Promise.all(pulls.map(async (pull) => {
    const details = await githubJson<GithubPull>(`${base}/pulls/${pull.number}`, options);
    const checksResponse = await githubJson<{ check_runs: GithubCheck[] }>(`${base}/commits/${pull.head.sha}/check-runs?per_page=100`, options);
    const checks = checksResponse.check_runs.map((check) => Object.freeze({
      name: check.name,
      status: checkStatus(check),
      conclusion: check.conclusion,
      url: check.details_url ?? null,
    })).sort((left, right) => left.name.localeCompare(right.name, "en"));
    const redChecks = checks.filter((check) => check.status === "FAIL").map((check) => check.name);
    const ci = checks.length === 0 ? "NOT_TESTED" : redChecks.length ? "FAIL" : checks.some((check) => check.status === "PENDING") ? "PENDING" : checks.some((check) => check.status === "NOT_TESTED") ? "NOT_TESTED" : "PASS";
    return Object.freeze({
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      headBranch: pull.head.ref,
      headSha: pull.head.sha,
      baseBranch: pull.base.ref,
      draft: pull.draft === true,
      state: details.merged_at ? "MERGED" : pull.state === "open" ? "OPEN" : "CLOSED",
      mergeable: details.mergeable === true ? "MERGEABLE" : details.mergeable === false ? "CONFLICTING" : "UNKNOWN",
      ci,
      checks: Object.freeze(checks),
      redChecks: Object.freeze(redChecks),
    } satisfies PullRequestState);
  }));
}
