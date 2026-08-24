export type ExecutionStatus = "PASS" | "FAIL" | "NOT_TESTED";
export type EvidenceKind = "git" | "github" | "command" | "file" | "artifact" | "capture";

export interface ToolEvidence {
  kind: EvidenceKind;
  locator: string;
  exitCode?: number;
}

export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Readonly<Record<string, unknown>>;
}

export interface ToolResult<T> {
  schemaVersion: "1";
  tool: "nexus_status" | "nexus_projects" | "nexus_gates" | "nexus_passport" | "nexus_capture" | "nexus_build" | "nexus_comparator" | "nexus_project_new";
  requestId: string;
  status: ExecutionStatus;
  repository: string;
  branch: string | null;
  sourceSha: string | null;
  startedAt: string;
  finishedAt: string;
  data: T | null;
  evidence: readonly ToolEvidence[];
  errors: readonly ToolError[];
}

export interface GitState {
  branch: string;
  headSha: string;
  detached: boolean;
  clean: boolean;
  changedPaths: readonly string[];
  remoteUrl: string | null;
}

export interface PullRequestCheck {
  name: string;
  status: "PASS" | "FAIL" | "PENDING" | "NOT_TESTED";
  conclusion: string | null;
  url: string | null;
}

export interface PullRequestState {
  number: number;
  title: string;
  url: string;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  draft: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  ci: "PASS" | "FAIL" | "PENDING" | "NOT_TESTED";
  checks: readonly PullRequestCheck[];
  redChecks: readonly string[];
}

export interface ProjectState {
  slug: string;
  path: string;
  packageName: string;
  workspaceMember: boolean;
  kind: "CLIENT" | "REFERENCE" | "PROBE" | "SEED" | "UNKNOWN";
  clientProject: boolean;
  evidence: {
    packageJsonPath: string;
    clientProjectDeclaration: boolean | null;
    classificationRule: string;
  };
}
