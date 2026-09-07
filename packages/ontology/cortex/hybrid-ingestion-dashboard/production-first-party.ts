import { SqliteDurableEventStream } from "../event-budget-stream/index.js";
import { HybridFinancialMetricStore, type DurableMetricEventReader } from "./index.js";
import type { Cortex18Mode } from "./runtime-control.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,191}$/u;

export class Cortex18FirstPartyConsumerError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "KILLED", message: string) {
    super(message);
    this.name = "Cortex18FirstPartyConsumerError";
  }
}

function safeMode(provider: () => Cortex18Mode): Cortex18Mode {
  try {
    const mode = provider();
    return mode === "ACTIVE" || mode === "OBSERVE_ONLY" || mode === "KILLED" ? mode : "KILLED";
  } catch {
    return "KILLED";
  }
}

export class Cortex18FirstPartyConsumer {
  constructor(
    private readonly store: HybridFinancialMetricStore,
    private readonly stream: SqliteDurableEventStream,
    private readonly streamName: string,
    private readonly consumerId: string,
    private readonly readMode: () => Cortex18Mode,
  ) {
    if (!store || !stream || !ID.test(streamName) || !ID.test(consumerId) || typeof readMode !== "function") throw new Cortex18FirstPartyConsumerError("INVALID_INPUT", "CORTEX #18 first-party consumer configuration is invalid");
  }

  runOnce(limit = 500): { consumed: number; inserted: number; offset: number } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Cortex18FirstPartyConsumerError("INVALID_INPUT", "CORTEX #18 first-party consumer limit is invalid");
    if (safeMode(this.readMode) !== "ACTIVE") return Object.freeze({ consumed: 0, inserted: 0, offset: this.stream.readOffset(this.consumerId, this.streamName) });

    const assertActive = () => {
      if (safeMode(this.readMode) !== "ACTIVE") throw new Cortex18FirstPartyConsumerError("KILLED", "CORTEX #18 killed at durable first-party mutation boundary");
    };

    const guardedReader: DurableMetricEventReader = {
      readOffset: (consumerId, streamName) => this.stream.readOffset(consumerId, streamName),
      read: (streamName, afterSequence, readLimit) => this.stream.read(streamName, afterSequence, readLimit),
      commitOffset: (consumerId, streamName, sequence) => {
        // This is the final side-effect boundary for first-party consumption. Re-read durable control
        // immediately before advancing the #17 consumer offset, and make #17 enforce the same guard
        // inside its own SQLite mutation transaction.
        assertActive();
        return this.stream.commitOffset(consumerId, streamName, sequence, assertActive);
      },
    };

    return this.store.ingestOwnStream(guardedReader, this.streamName, this.consumerId, limit, assertActive);
  }
}
