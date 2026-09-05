import { NextResponse, type NextRequest } from "next/server";
import { AD_CONTEXT_HEADERS, resolveCanoAdContext } from "./ad-context";

export function middleware(request: NextRequest) {
  const decision = resolveCanoAdContext(request.nextUrl, process.env.NEXUS_AD_CONTEXT_MODE);
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

  if (decision.applied) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
  }
  return response;
}

export const config = {
  matcher: "/",
};
