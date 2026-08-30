export type SemanticValue = string | number | boolean | null;

export interface SemanticState {
  readonly authority: "NEXUS_SEMANTIC_STATE_V1";
  readonly facts: Readonly<Record<string, SemanticValue>>;
  readonly metrics: Readonly<Record<string, number>>;
  readonly digest: string;
}

export type SemanticOperand =
  | Readonly<{ kind: "literal"; value: SemanticValue }>
  | Readonly<{ kind: "fact"; name: string }>
  | Readonly<{ kind: "metric"; name: string }>;

export type SemanticComparator = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";

export type SemanticFormula =
  | Readonly<{ op: "true" }>
  | Readonly<{ op: "false" }>
  | Readonly<{ op: "exists"; operand: Exclude<SemanticOperand, { kind: "literal" }> }>
  | Readonly<{ op: "compare"; left: SemanticOperand; comparator: SemanticComparator; right: SemanticOperand }>
  | Readonly<{ op: "not"; formula: SemanticFormula }>
  | Readonly<{ op: "and"; formulas: readonly SemanticFormula[] }>
  | Readonly<{ op: "or"; formulas: readonly SemanticFormula[] }>
  | Readonly<{ op: "implies"; antecedent: SemanticFormula; consequent: SemanticFormula }>;

export interface SemanticRule {
  readonly id: string;
  readonly formula: SemanticFormula;
  readonly message?: string;
}

export interface SemanticContract {
  readonly id: string;
  readonly requires?: readonly SemanticRule[];
  readonly ensures?: readonly SemanticRule[];
  readonly invariants?: readonly SemanticRule[];
}

export type SemanticEffect =
  | Readonly<{ kind: "set_fact"; name: string; value: SemanticValue }>
  | Readonly<{ kind: "delete_fact"; name: string }>
  | Readonly<{ kind: "set_metric"; name: string; value: number }>
  | Readonly<{ kind: "add_metric"; name: string; value: number }>
  | Readonly<{ kind: "min_metric"; name: string; value: number }>
  | Readonly<{ kind: "max_metric"; name: string; value: number }>;

interface CompositionBase {
  readonly id: string;
  readonly contract?: SemanticContract;
}

export interface SemanticStep extends CompositionBase {
  readonly kind: "step";
  readonly effects: readonly SemanticEffect[];
}

export interface SemanticSequence extends CompositionBase {
  readonly kind: "sequence";
  readonly children: readonly SemanticComposition[];
}

export interface SemanticParallel extends CompositionBase {
  readonly kind: "parallel";
  readonly children: readonly SemanticComposition[];
}

export interface SemanticNest extends CompositionBase {
  readonly kind: "nest";
  readonly children: readonly SemanticComposition[];
}

export type SemanticComposition = SemanticStep | SemanticSequence | SemanticParallel | SemanticNest;

export type VerificationStatus = "VERIFIED" | "REJECTED";

export interface VerificationPolicy {
  readonly maxDepth: number;
  readonly failFast: boolean;
}

export type VerificationIssueCode =
  | "PRECONDITION_FAILED"
  | "POSTCONDITION_FAILED"
  | "INVARIANT_FAILED"
  | "PARALLEL_CONFLICT"
  | "MISSING_METRIC"
  | "INVALID_EFFECT"
  | "INVALID_COMPOSITION";

export interface VerificationIssue {
  readonly code: VerificationIssueCode;
  readonly nodeId: string;
  readonly ruleId?: string;
  readonly message: string;
}

export type VerificationTracePhase =
  | "REQUIRES"
  | "EFFECTS"
  | "INVARIANT"
  | "ENSURES"
  | "PARALLEL_MERGE";

export type VerificationTraceStatus = "PASS" | "FAIL" | "APPLIED";

export interface VerificationTraceEntry {
  readonly nodeId: string;
  readonly phase: VerificationTracePhase;
  readonly status: VerificationTraceStatus;
  readonly stateDigest: string;
  readonly ruleId?: string;
  readonly detail: string;
}

export interface SemanticVerificationCertificate {
  readonly authority: "NEXUS_COMPOSITIONAL_SEMANTICS_V1";
  readonly version: 1;
  readonly planId: string;
  readonly subject: string;
  readonly compositionDigest: string;
  readonly initialStateDigest: string;
  readonly finalStateDigest: string;
  readonly status: VerificationStatus;
  readonly policyDigest: string;
  readonly issuesDigest: string;
  readonly traceDigest: string;
  readonly certificateDigest: string;
}

export interface VerificationResult {
  readonly status: VerificationStatus;
  readonly policy: VerificationPolicy;
  readonly composition: SemanticComposition;
  readonly compositionDigest: string;
  readonly initialState: SemanticState;
  readonly finalState: SemanticState;
  readonly issues: readonly VerificationIssue[];
  readonly trace: readonly VerificationTraceEntry[];
  readonly certificate: SemanticVerificationCertificate;
}

export interface VerifyCompositionInput {
  readonly planId: string;
  readonly subject: string;
  readonly initialState: SemanticState;
  readonly composition: SemanticComposition;
  readonly maxDepth?: number;
  readonly failFast?: boolean;
}
