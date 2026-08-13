import type { JourneyRole } from "./capabilities";

export type CompositionMove =
  | { kind: "sequence"; subjects: readonly string[]; purpose: string }
  | { kind: "juxtapose"; subjects: readonly [string, string]; purpose: string }
  | { kind: "layer"; subjects: readonly string[]; purpose: string }
  | { kind: "isolate"; subject: string; purpose: string }
  | { kind: "interrupt"; subject: string; purpose: string }
  | { kind: "anchor"; subject: string; purpose: string }
  | { kind: "reveal"; subject: string; purpose: string }
  | { kind: "echo"; subject: string; purpose: string };

export type CompositionStage = {
  id: string;
  purpose: string;
  acceptsRoles: readonly JourneyRole[];
  moves: readonly CompositionMove[];
  minCapabilityCount?: number;
  maxCapabilityCount?: number;
};

export type NarrativeSequence = readonly CompositionStage[];
