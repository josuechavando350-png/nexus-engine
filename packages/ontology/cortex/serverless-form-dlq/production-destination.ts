import type { FormSubmission, LeadDestination } from "./index.js";
import { Cortex20WorkerError } from "./production-worker.js";
import type { Cortex20Mode } from "./runtime-control.js";

function safeMode(provider: () => Cortex20Mode): Cortex20Mode {
  try {
    const mode = provider();
    return mode === "ACTIVE" || mode === "OBSERVE_ONLY" || mode === "KILLED" ? mode : "KILLED";
  } catch {
    return "KILLED";
  }
}

/**
 * Production decorator that places the durable kill switch at the final boundary before the
 * downstream lead side effect. The delegate's deliver() starts its fetch synchronously, so there
 * is no await between this control read and the network POST.
 */
export class KillGuardedLeadDestination implements LeadDestination {
  constructor(private readonly delegate: LeadDestination, private readonly readMode: () => Cortex20Mode) {
    if (!delegate || typeof delegate.deliver !== "function" || typeof readMode !== "function") throw new Cortex20WorkerError("INVALID_INPUT", "guarded destination configuration is invalid");
  }

  async deliver(submission: FormSubmission, idempotencyKey: string): Promise<{ receiptId: string }> {
    if (safeMode(this.readMode) !== "ACTIVE") throw new Cortex20WorkerError("KILLED", "CORTEX #20 killed at final lead-delivery boundary");
    return this.delegate.deliver(submission, idempotencyKey);
  }
}
