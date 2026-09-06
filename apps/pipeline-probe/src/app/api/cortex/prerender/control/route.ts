export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_PATHS = Object.freeze(["/", "/explore", "/proof", "/visit", "/contact"]);
const DEFAULT_MAX_PREPARED_TARGETS = 4;

function configuredControl() {
  const rawMode = process.env.NEXUS_CORTEX_08_MODE?.trim();
  const mode = rawMode === "ACTIVE" || rawMode === "OBSERVE_ONLY" || rawMode === "KILLED" ? rawMode : "KILLED";
  const rawMax = process.env.NEXUS_CORTEX_08_MAX_PREPARED_TARGETS?.trim();
  let maxPreparedTargets = DEFAULT_MAX_PREPARED_TARGETS;
  let effectiveMode = mode;
  if (rawMax) {
    if (!/^\d+$/u.test(rawMax)) {
      effectiveMode = "KILLED";
      maxPreparedTargets = 1;
    } else {
      const parsed = Number(rawMax);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 16) {
        effectiveMode = "KILLED";
        maxPreparedTargets = 1;
      } else {
        maxPreparedTargets = parsed;
      }
    }
  }
  return { mode: effectiveMode, allowedPaths: ALLOWED_PATHS, maxPreparedTargets } as const;
}

export async function GET(): Promise<Response> {
  return Response.json(configuredControl(), {
    status: 200,
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}
