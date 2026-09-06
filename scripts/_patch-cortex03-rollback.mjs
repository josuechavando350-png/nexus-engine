import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const sourcePath = "packages/ontology/cortex/creative-sync/index.ts";
const workflowPath = ".github/workflows/_cortex03-rollback-patch.yml";
const selfPath = "scripts/_patch-cortex03-rollback.mjs";
const before = `  async rollbackLastMutation(input: CreativeSyncRollbackInput): Promise<CreativeSyncResult> {
    const runId = identifier(input.runId, "runId");
    const customer = customerId(input.customerId);
    const existing = this.readRun(runId, customer);
    if (existing) return this.execute(existing, "ACTIVE");
    const state = this.readState(customer);
    if (!state?.lastAppliedAction || !state.lastRollbackAction) throw new CreativeSyncError("POLICY_VIOLATION", "no certified creative action is available for rollback");
    if (state.inFlightRunId) {
      const inFlight = this.readRun(state.inFlightRunId, customer);
      if (!inFlight) throw new CreativeSyncError("INTEGRITY_FAILURE", "state references missing in-flight run");
      return this.execute(inFlight, "ACTIVE");
    }
    const now = this.time();`;
const after = `  async rollbackLastMutation(input: CreativeSyncRollbackInput): Promise<CreativeSyncResult> {
    const runId = identifier(input.runId, "runId");
    const customer = customerId(input.customerId);
    const existing = this.readRun(runId, customer);
    if (existing) {
      if (existing.reason !== "ROLLBACK_APPLIED") throw new CreativeSyncError("POLICY_VIOLATION", "rollback cannot resume a forward prepared creative mutation");
      return this.execute(existing, "ACTIVE");
    }
    const state = this.readState(customer);
    if (!state?.lastAppliedAction || !state.lastRollbackAction) throw new CreativeSyncError("POLICY_VIOLATION", "no certified creative action is available for rollback");
    if (state.inFlightRunId) {
      const inFlight = this.readRun(state.inFlightRunId, customer);
      if (!inFlight) throw new CreativeSyncError("INTEGRITY_FAILURE", "state references missing in-flight run");
      if (inFlight.reason !== "ROLLBACK_APPLIED") throw new CreativeSyncError("POLICY_VIOLATION", "rollback cannot resume a forward prepared creative mutation");
      return this.execute(inFlight, "ACTIVE");
    }
    const now = this.time();`;

const source = readFileSync(sourcePath, "utf8");
if (!source.includes(before)) throw new Error("creative rollback source block did not match exactly");
if (source.indexOf(before) !== source.lastIndexOf(before)) throw new Error("creative rollback source block matched more than once");
const patched = source.replace(before, after);
if (patched === source) throw new Error("creative rollback source patch made no change");
writeFileSync(sourcePath, patched, "utf8");
unlinkSync(selfPath);
unlinkSync(workflowPath);
