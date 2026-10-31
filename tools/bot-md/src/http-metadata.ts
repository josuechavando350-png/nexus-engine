/** Keep application routing semantics, without replaying cookies, TLS, transport or security headers. */
export function replayResponseHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) =>
        key.startsWith("x-nextjs-") ||
        ["vary", "content-language"].includes(key),
    ),
  );
}
export function routingRequestHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) =>
        key === "rsc" || key.startsWith("next-router-") || key === "next-url",
    ),
  );
}
export function optionalPrefetchCancelled(
  error: string | undefined,
  headers: Record<string, string>,
  recordedMime: string | undefined,
) {
  return (
    error === "net::ERR_ABORTED" &&
    headers["next-router-prefetch"] === "1" &&
    Boolean(recordedMime?.includes("text/x-component"))
  );
}
