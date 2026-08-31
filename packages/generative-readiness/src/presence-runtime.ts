import { createPage, type GenerativePageInput } from "./index.js";
import {
  assessGenerativePresence,
  validatePresenceScope,
  type ExternalVisibilityState,
  type GenerativePresenceReport,
  type PresenceScope,
} from "./presence.js";

export interface GenerativePresenceRuntimeRequest {
  readonly scope: PresenceScope;
  readonly page: GenerativePageInput;
  readonly observedAt: string;
  readonly externalVisibilityState?: ExternalVisibilityState;
}

export function runGenerativePresence(
  request: GenerativePresenceRuntimeRequest,
  signal?: AbortSignal,
): GenerativePresenceReport {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("generative presence request must be an object");
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("generative presence cancelled");
  const scope = validatePresenceScope(request.scope);
  const page = createPage(request.page);
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("generative presence cancelled");
  return assessGenerativePresence(scope, page, request.observedAt, request.externalVisibilityState ?? "NOT_VERIFIED");
}
