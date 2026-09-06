import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { AD_CONTEXT_HEADERS, resolveCanoAdContext } from "./ad-context";
import { effectiveCanoAdContextMode, recordCanoAdContextDecision } from "./ad-context-control";

export async function middleware(request: NextRequest, event: NextFetchEvent) {
  const mode = await effectiveCanoAdContextMode();
  const decision = resolveCanoAdContext(request.nextUrl, mode);
  const requestHeaders = new Headers(request.headers);

  for (const headerName of Object.values(AD_CONTEXT_HEADERS)) requestHeaders.delete(headerName);
  requestHeaders.set(AD_CONTEXT_HEADERS.experience, decision.experienceId);
  requestHeaders.set(AD_CONTEXT_HEADERS.channel, decision.channel);
  requestHeaders.set(AD_CONTEXT_HEADERS.reason, decision.reason);
  requestHeaders.set(AD_CONTEXT_HEADERS.applied, decision.applied ? "1" : "0");

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(AD_CONTEXT_HEADERS.experience, decision.experienceId);
  response.headers.set(AD_CONTEXT_HEADERS.channel, decision.channel);
  response.headers.set(AD_CONTEXT_HEADERS.applied, decision.applied ? "1" : "0");

  if (decision.applied) response.headers.set("Cache-Control", "private, no-store, max-age=0");
  event.waitUntil(recordCanoAdContextDecision(decision));
  return response;
}

export const config = {
  matcher: "/",
};
