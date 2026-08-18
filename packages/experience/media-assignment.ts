import { createHash } from "node:crypto";

export interface MediaAssignmentCandidate {
  assetId: string;
  filePath: string;
  publicPath: string;
  sourceDigest: `sha256:${string}`;
  source: string;
  rights: "OWNED" | "LICENSED" | "CLIENT_SUPPLIED" | "PUBLIC_DOMAIN";
  observedContent: string;
  width: number;
  height: number;
}

export interface AssignedMediaRole extends MediaAssignmentCandidate {
  role: string;
  rationale: string;
  evidenceIds: readonly string[];
}

export interface MediaAssignmentResult {
  authority: "NEXUS_MEDIA_ROLE_ASSIGNMENT_V1";
  assignments: readonly AssignedMediaRole[];
  assignmentDigest: `sha256:${string}`;
}

const ROLE_SIGNALS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "hero-media": Object.freeze(["environment", "interior", "portrait", "team", "space", "context", "wide", "landscape", "subject", "service"]),
  "proof-media": Object.freeze(["process", "working", "work", "equipment", "detail", "demonstration", "technology", "craft", "procedure", "service"]),
  "documentary-context": Object.freeze(["entrance", "exterior", "reception", "location", "signage", "interior", "environment", "space", "street", "context"]),
  "cinematic-sequence": Object.freeze(["action", "process", "working", "environment", "interior", "wide", "sequence", "movement", "service", "city"]),
});

const normalize = (value: string): string => value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
const digest = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function validateCandidate(candidate: MediaAssignmentCandidate): void {
  if (!candidate.assetId.trim() || !candidate.filePath.trim() || !candidate.publicPath.startsWith("/") || !candidate.source.trim() || !candidate.observedContent.trim()) throw new Error("media candidate requires assetId, filePath, rooted publicPath, source and observedContent");
  if (!/^sha256:[a-f0-9]{64}$/.test(candidate.sourceDigest)) throw new Error(`media candidate ${candidate.assetId} requires a canonical sourceDigest`);
  if (!Number.isInteger(candidate.width) || candidate.width < 1 || !Number.isInteger(candidate.height) || candidate.height < 1) throw new Error(`media candidate ${candidate.assetId} requires positive integer dimensions`);
}

function score(role: string, candidate: MediaAssignmentCandidate): number {
  const text = normalize(candidate.observedContent);
  const signals = ROLE_SIGNALS[role] ?? [];
  let value = signals.reduce((total, signal) => total + (text.includes(signal) ? 3 : 0), 0);
  const landscape = candidate.width / candidate.height >= 1.2;
  const portrait = candidate.height / candidate.width >= 1.2;
  if (role === "hero-media" && landscape) value += 3;
  if (role === "cinematic-sequence" && landscape) value += 2;
  if (role === "documentary-context" && portrait) value += 1;
  if (role === "proof-media" && !landscape && !portrait) value += 1;
  value += Math.min(2, Math.log2(Math.max(candidate.width * candidate.height, 1)) / 12);
  return Number(value.toFixed(6));
}

function assignmentKey(assignments: readonly { role: string; assetId: string }[]): string {
  return assignments.map((item) => `${item.role}:${item.assetId}`).join("|");
}

export function assignMediaRoles(input: {
  requiredRoles: readonly string[];
  candidates: readonly MediaAssignmentCandidate[];
}): MediaAssignmentResult {
  const roles = input.requiredRoles.map((role) => role.trim()).filter(Boolean);
  if (roles.length !== input.requiredRoles.length || new Set(roles).size !== roles.length) throw new Error("required media roles must be unique non-empty strings");
  const candidates = input.candidates.map((candidate) => Object.freeze({ ...candidate }));
  for (const candidate of candidates) validateCandidate(candidate);
  if (new Set(candidates.map((candidate) => candidate.assetId)).size !== candidates.length) throw new Error("media candidate assetIds must be unique");
  if (roles.length > candidates.length) throw new Error(`media assignment requires ${roles.length} distinct assets but only ${candidates.length} authorized candidates exist`);
  if (!roles.length) return Object.freeze({ authority: "NEXUS_MEDIA_ROLE_ASSIGNMENT_V1", assignments: Object.freeze([]), assignmentDigest: digest("[]") });

  let bestScore = Number.NEGATIVE_INFINITY;
  let best: Array<{ role: string; candidate: MediaAssignmentCandidate; score: number }> | undefined;

  const visit = (roleIndex: number, used: Set<string>, current: Array<{ role: string; candidate: MediaAssignmentCandidate; score: number }>, total: number) => {
    if (roleIndex === roles.length) {
      const currentKey = assignmentKey(current.map(({ role, candidate }) => ({ role, assetId: candidate.assetId })));
      const bestKey = best ? assignmentKey(best.map(({ role, candidate }) => ({ role, assetId: candidate.assetId }))) : "";
      if (total > bestScore || (total === bestScore && (!best || currentKey.localeCompare(bestKey, "en") < 0))) {
        bestScore = total;
        best = current.map((item) => ({ ...item }));
      }
      return;
    }
    const role = roles[roleIndex]!;
    for (const candidate of candidates) {
      if (used.has(candidate.assetId)) continue;
      used.add(candidate.assetId);
      const candidateScore = score(role, candidate);
      current.push({ role, candidate, score: candidateScore });
      visit(roleIndex + 1, used, current, total + candidateScore);
      current.pop();
      used.delete(candidate.assetId);
    }
  };
  visit(0, new Set(), [], 0);
  if (!best) throw new Error("media assignment failed to find a complete authorized assignment");

  const assignments = best.map(({ role, candidate, score: assignmentScore }) => Object.freeze({
    ...candidate,
    role,
    rationale: `NEXUS selected ${candidate.assetId} for ${role} using generic semantic/context, orientation and resolution evidence; assignment score ${assignmentScore} is measured selection evidence, not an aesthetic quality score.`,
    evidenceIds: Object.freeze([candidate.sourceDigest, `observed:${candidate.assetId}`]),
  }));
  const canonical = JSON.stringify(assignments.map(({ role, assetId, sourceDigest }) => ({ role, assetId, sourceDigest })));
  return Object.freeze({ authority: "NEXUS_MEDIA_ROLE_ASSIGNMENT_V1", assignments: Object.freeze(assignments), assignmentDigest: digest(canonical) });
}
