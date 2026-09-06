export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type Cortex09Mode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";

export function readCortex09Mode(): Cortex09Mode {
  const raw = process.env.NEXUS_CORTEX_09_MODE?.trim();
  return raw === "ACTIVE" || raw === "OBSERVE_ONLY" || raw === "KILLED" ? raw : "KILLED";
}

export async function GET(): Promise<Response> {
  return Response.json({ mode: readCortex09Mode() }, {
    status: 200,
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}
