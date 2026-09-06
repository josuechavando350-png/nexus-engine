export type Cortex09Mode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";

export function readCortex09Mode(): Cortex09Mode {
  const raw = process.env.NEXUS_CORTEX_09_MODE?.trim();
  return raw === "ACTIVE" || raw === "OBSERVE_ONLY" || raw === "KILLED" ? raw : "KILLED";
}
