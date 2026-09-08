import { createHash } from "node:crypto";
import { Cortex20Error, type FormSubmission, type LeadDestination } from "../serverless-form-dlq/index";
import { parseRelayInput, type RelayGateway, type RelayInput } from "../webhook-relay/index";
import { createPymeConsentSubjectId, SqlitePymeConsentRegistry, type PymeConsentChannel } from "./consent-registry";

const FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;

export type PymeLeadRelayChannel = "WEBHOOK" | "WHATSAPP" | "SMS";

export interface PymeConsentAwareRelayConfig {
  readonly registry: SqlitePymeConsentRegistry;
  readonly gateway: RelayGateway;
  readonly channel: PymeLeadRelayChannel;
  readonly purpose: string;
  readonly subjectField: string;
  readonly subjectKind: "EMAIL" | "PHONE" | "OPAQUE";
  /** Explicit deployment acknowledgement that the remote endpoint deduplicates by RelayInput.eventId. */
  readonly idempotencyContract: "EVENT_ID_IDEMPOTENT";
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function consentChannel(channel: PymeLeadRelayChannel): PymeConsentChannel {
  return channel;
}

function eventType(channel: PymeLeadRelayChannel): string {
  return channel === "WHATSAPP" ? "pyme.lead.whatsapp" : channel === "SMS" ? "pyme.lead.sms" : "pyme.lead.webhook";
}

export class PymeConsentAwareLeadDestination implements LeadDestination {
  constructor(private readonly config: PymeConsentAwareRelayConfig) {
    if (config.idempotencyContract !== "EVENT_ID_IDEMPOTENT") throw new Cortex20Error("INVALID_INPUT", "PyME relay requires an event-id idempotency contract");
    if (!ID.test(config.purpose) || !FIELD.test(config.subjectField)) throw new Cortex20Error("INVALID_INPUT", "PyME relay purpose or subjectField is invalid");
    if ((config.channel === "WHATSAPP" || config.channel === "SMS") && config.subjectKind !== "PHONE") throw new Cortex20Error("INVALID_INPUT", "WhatsApp/SMS PyME relay requires a phone consent subject");
  }

  async deliver(submission: FormSubmission, idempotencyKey: string): Promise<{ receiptId: string }> {
    if (!ID.test(idempotencyKey)) throw new Cortex20Error("INVALID_INPUT", "PyME relay idempotency key is malformed");
    const subjectValue = submission.fields[this.config.subjectField];
    if (typeof subjectValue !== "string") throw new Cortex20Error("INVALID_INPUT", `PyME relay subject field ${this.config.subjectField} is missing`);
    const subjectId = createPymeConsentSubjectId(this.config.subjectKind, subjectValue);
    const decision = this.config.registry.authorize(subjectId, consentChannel(this.config.channel), this.config.purpose, idempotencyKey, submission.submittedAt);
    if (!decision.authorized) {
      this.config.registry.recordUse(subjectId, consentChannel(this.config.channel), this.config.purpose, "SUPPRESSED", idempotencyKey, `CONSENT_${decision.reason}`, submission.submittedAt);
      return { receiptId: `suppressed-${digest(idempotencyKey).slice(0, 24)}` };
    }

    const relay: RelayInput = parseRelayInput({
      eventId: idempotencyKey,
      eventType: eventType(this.config.channel),
      occurredAt: submission.submittedAt,
      adUserDataConsent: "GRANTED",
      userIdentifiers: [],
      data: {
        submissionId: submission.submissionId,
        formId: submission.formId,
        fields: submission.fields,
      },
    });

    try {
      const receipt = await this.config.gateway.send(relay, `sha256:${digest(JSON.stringify(relay))}`);
      this.config.registry.recordUse(subjectId, consentChannel(this.config.channel), this.config.purpose, "DISPATCHED", idempotencyKey, "PROVIDER_ACK", submission.submittedAt);
      return { receiptId: receipt.requestId };
    } catch (error) {
      this.config.registry.recordUse(subjectId, consentChannel(this.config.channel), this.config.purpose, "FAILED", idempotencyKey, "PROVIDER_FAILURE", submission.submittedAt);
      throw new Cortex20Error("DESTINATION_FAILURE", error instanceof Error ? `PyME relay provider failed: ${error.message}` : "PyME relay provider failed");
    }
  }
}
