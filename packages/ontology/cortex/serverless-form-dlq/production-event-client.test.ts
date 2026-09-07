import { afterEach, describe, expect, it, vi } from "vitest";
import { Cortex20WorkerError, HttpCortex17FormEventClient } from "./production-worker";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const origin = new URL("https://events.example/");
const readToken = "r".repeat(32);
const writeToken = "w".repeat(32);

describe("CORTEX #20 CORTEX #17 mutation client", () => {
  it("blocks DLQ append at the final HTTP boundary when durable control is killed", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const client = new HttpCortex17FormEventClient(origin, readToken, writeToken, 1000, () => { throw new Cortex20WorkerError("KILLED", "killed"); });
    await expect(client.append({ stream: "forms.dlq", eventId: "dlq-event-00000001", occurredAt: "2026-09-06T00:00:00.000Z", payload: { encryptedLead: "opaque" } })).rejects.toMatchObject({ code: "KILLED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks offset commit at the final HTTP boundary when durable control is killed", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const client = new HttpCortex17FormEventClient(origin, readToken, writeToken, 1000, () => { throw new Cortex20WorkerError("KILLED", "killed"); });
    await expect(client.commitOffset("forms-worker-0001", "forms.accepted", 7)).rejects.toMatchObject({ code: "KILLED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed if the mutation guard itself becomes unavailable", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const client = new HttpCortex17FormEventClient(origin, readToken, writeToken, 1000, () => { throw new Error("control unavailable"); });
    await expect(client.commitOffset("forms-worker-0001", "forms.accepted", 7)).rejects.toMatchObject({ code: "KILLED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
