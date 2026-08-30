import type {
  SemanticComposition,
  SemanticRule,
  SemanticState,
  VerificationIssue,
  VerificationIssueCode,
  VerificationPolicy,
  VerificationTraceEntry,
  VerificationTracePhase,
} from "./types.js";
import { applySemanticEffects, SemanticStateError } from "./state.js";
import { evaluateSemanticFormula } from "./formula.js";
import { mergeParallelStates, orderedParallelChildren } from "./composition.js";

interface ExecutionContext {
  readonly failFast: boolean;
  readonly issues: VerificationIssue[];
  readonly trace: VerificationTraceEntry[];
}

interface ExecutionOutcome {
  readonly state: SemanticState;
  readonly accepted: boolean;
}

export interface SemanticExecutionEvidence {
  readonly state: SemanticState;
  readonly accepted: boolean;
  readonly issues: readonly VerificationIssue[];
  readonly trace: readonly VerificationTraceEntry[];
}

function sortedRules(rules: readonly SemanticRule[] | undefined): readonly SemanticRule[] {
  return Object.freeze([...(rules ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
}

function pushIssue(
  context: ExecutionContext,
  code: VerificationIssueCode,
  nodeId: string,
  message: string,
  ruleId?: string,
): void {
  context.issues.push(Object.freeze({ code, nodeId, ...(ruleId ? { ruleId } : {}), message }));
}

function pushTrace(
  context: ExecutionContext,
  nodeId: string,
  phase: VerificationTracePhase,
  status: VerificationTraceEntry["status"],
  state: SemanticState,
  detail: string,
  ruleId?: string,
): void {
  context.trace.push(Object.freeze({
    nodeId,
    phase,
    status,
    stateDigest: state.digest,
    ...(ruleId ? { ruleId } : {}),
    detail,
  }));
}

function evaluateRules(
  context: ExecutionContext,
  nodeId: string,
  state: SemanticState,
  rules: readonly SemanticRule[] | undefined,
  phase: "REQUIRES" | "INVARIANT" | "ENSURES",
  issueCode: "PRECONDITION_FAILED" | "INVARIANT_FAILED" | "POSTCONDITION_FAILED",
): boolean {
  let passed = true;
  for (const rule of sortedRules(rules)) {
    const ok = evaluateSemanticFormula(state, rule.formula);
    pushTrace(context, nodeId, phase, ok ? "PASS" : "FAIL", state, rule.message ?? `${phase.toLowerCase()} ${rule.id}`, rule.id);
    if (!ok) {
      passed = false;
      pushIssue(context, issueCode, nodeId, rule.message ?? `${phase.toLowerCase()} rule ${rule.id} failed`, rule.id);
      if (context.failFast) break;
    }
  }
  return passed;
}

function checkRequires(context: ExecutionContext, node: SemanticComposition, state: SemanticState): boolean {
  return evaluateRules(context, node.id, state, node.contract?.requires, "REQUIRES", "PRECONDITION_FAILED");
}

function checkInvariants(context: ExecutionContext, node: SemanticComposition, state: SemanticState): boolean {
  return evaluateRules(context, node.id, state, node.contract?.invariants, "INVARIANT", "INVARIANT_FAILED");
}

function checkEnsures(context: ExecutionContext, node: SemanticComposition, state: SemanticState): boolean {
  return evaluateRules(context, node.id, state, node.contract?.ensures, "ENSURES", "POSTCONDITION_FAILED");
}

function executeNode(context: ExecutionContext, node: SemanticComposition, input: SemanticState): ExecutionOutcome {
  if (!checkRequires(context, node, input)) return { state: input, accepted: false };

  switch (node.kind) {
    case "step": {
      let next: SemanticState;
      try {
        next = applySemanticEffects(input, node.effects);
      } catch (error) {
        if (error instanceof SemanticStateError) {
          pushIssue(context, error.code === "MISSING_METRIC" ? "MISSING_METRIC" : "INVALID_EFFECT", node.id, error.message);
          return { state: input, accepted: false };
        }
        throw error;
      }
      pushTrace(context, node.id, "EFFECTS", "APPLIED", next, `${node.effects.length} effect(s) applied`);
      if (!checkInvariants(context, node, next)) return { state: next, accepted: false };
      if (!checkEnsures(context, node, next)) return { state: next, accepted: false };
      return { state: next, accepted: true };
    }

    case "sequence": {
      let state = input;
      for (const child of node.children) {
        const outcome = executeNode(context, child, state);
        state = outcome.state;
        if (!outcome.accepted) return { state, accepted: false };
      }
      if (!checkInvariants(context, node, state)) return { state, accepted: false };
      if (!checkEnsures(context, node, state)) return { state, accepted: false };
      return { state, accepted: true };
    }

    case "nest": {
      let state = input;
      for (const child of node.children) {
        const outcome = executeNode(context, child, state);
        state = outcome.state;
        if (!outcome.accepted) return { state, accepted: false };
        if (!checkInvariants(context, node, state)) return { state, accepted: false };
      }
      if (!checkEnsures(context, node, state)) return { state, accepted: false };
      return { state, accepted: true };
    }

    case "parallel": {
      const branchStates: SemanticState[] = [];
      for (const child of orderedParallelChildren(node)) {
        const branchContext: ExecutionContext = { failFast: context.failFast, issues: [], trace: [] };
        const outcome = executeNode(branchContext, child, input);
        context.issues.push(...branchContext.issues);
        context.trace.push(...branchContext.trace);
        if (!outcome.accepted) return { state: input, accepted: false };
        branchStates.push(outcome.state);
      }
      const merged = mergeParallelStates(input, branchStates);
      if (!merged.state) {
        pushIssue(context, "PARALLEL_CONFLICT", node.id, merged.conflict ?? "parallel state conflict");
        pushTrace(context, node.id, "PARALLEL_MERGE", "FAIL", input, merged.conflict ?? "parallel state conflict");
        return { state: input, accepted: false };
      }
      pushTrace(context, node.id, "PARALLEL_MERGE", "APPLIED", merged.state, `${branchStates.length} branch(es) merged`);
      if (!checkInvariants(context, node, merged.state)) return { state: merged.state, accepted: false };
      if (!checkEnsures(context, node, merged.state)) return { state: merged.state, accepted: false };
      return { state: merged.state, accepted: true };
    }
  }
}

export function executeSemanticComposition(
  composition: SemanticComposition,
  initialState: SemanticState,
  policy: VerificationPolicy,
): SemanticExecutionEvidence {
  const context: ExecutionContext = { failFast: policy.failFast, issues: [], trace: [] };
  const outcome = executeNode(context, composition, initialState);
  return Object.freeze({
    state: outcome.state,
    accepted: outcome.accepted,
    issues: Object.freeze([...context.issues]),
    trace: Object.freeze([...context.trace]),
  });
}
