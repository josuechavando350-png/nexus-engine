import { lexicalCompare, type VerdictState } from "../shared";

export type ArtifactFingerprintCode =
  | "INVALID_RENDERED_ARTIFACT"
  | "NUMBERED_SECTIONS"
  | "DECORATIVE_ARROWS"
  | "GENERIC_SECTION_STACK"
  | "REPEATED_EYEBROW_LABELS"
  | "GENERIC_CARD_GRID"
  | "GENERIC_GRADIENT_SURFACE";

export type ArtifactFingerprintFinding = Readonly<{
  code: ArtifactFingerprintCode;
  severity: "BLOCK" | "WARN";
  detail: string;
}>;

export type ArtifactFingerprintPolicy = Readonly<{
  forbiddenPatterns?: readonly string[];
  failOnGenericCombination?: boolean;
}>;

export type RenderedCreativeArtifact = Readonly<{
  html: string;
  css?: string;
}>;

export type ArtifactFingerprintReport = Readonly<{
  authority: "NEXUS_ARTIFACT_FINGERPRINT_CRITIC";
  verdict: VerdictState;
  approved: boolean;
  findings: readonly ArtifactFingerprintFinding[];
}>;

const normalize = (value: string): string => value.trim().toLowerCase();

function finding(code: ArtifactFingerprintCode, detail: string, severity: "BLOCK" | "WARN" = "BLOCK"): ArtifactFingerprintFinding {
  return Object.freeze({ code, detail, severity });
}

function textFromHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|ensp|emsp);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function forbidden(policy: ArtifactFingerprintPolicy, needles: readonly string[]): boolean {
  const values = (policy.forbiddenPatterns ?? []).map(normalize);
  return values.some((value) => needles.some((needle) => value.includes(needle)));
}

function hasNumberedSectionRun(text: string): boolean {
  const values = [...text.matchAll(/(?:^|\s)0([1-9])(?=\s|$)/g)].map((match) => Number(match[1]));
  const unique = [...new Set(values)].sort((a, b) => a - b);
  return unique.length >= 3 && unique[0] === 1 && unique[1] === 2 && unique[2] === 3;
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function hasGenericSectionStack(html: string): boolean {
  const normalized = html.toLowerCase();
  const signals = [
    /<(?:header|nav)\b/.test(normalized),
    /class=["'][^"']*\bhero\b/.test(normalized),
    /class=["'][^"']*\b(?:features?|cards?)\b/.test(normalized),
    /class=["'][^"']*\bgallery\b/.test(normalized),
    /class=["'][^"']*\bcontact\b/.test(normalized),
    /<footer\b/.test(normalized),
  ];
  return signals.filter(Boolean).length >= 4;
}

function hasGenericCardGrid(html: string, css: string): boolean {
  const cardMentions = countMatches(html.toLowerCase(), /class=["'][^"']*\bcard\b[^"']*["']/g);
  const gridSurface = /display\s*:\s*grid/i.test(css) || /grid-template-columns\s*:/i.test(css);
  return cardMentions >= 3 && gridSurface;
}

export class NexusArtifactFingerprintCritic {
  evaluate(artifact: RenderedCreativeArtifact, policy: ArtifactFingerprintPolicy = {}): ArtifactFingerprintReport {
    if (!artifact || typeof artifact.html !== "string" || !artifact.html.trim() || (artifact.css !== undefined && typeof artifact.css !== "string")) {
      return Object.freeze({
        authority: "NEXUS_ARTIFACT_FINGERPRINT_CRITIC",
        verdict: "FAIL",
        approved: false,
        findings: Object.freeze([finding("INVALID_RENDERED_ARTIFACT", "rendered HTML is required and CSS must be a string when supplied")]),
      });
    }

    const findings: ArtifactFingerprintFinding[] = [];
    const text = textFromHtml(artifact.html);
    const css = artifact.css ?? "";

    if (hasNumberedSectionRun(text)) {
      findings.push(finding(
        "NUMBERED_SECTIONS",
        "rendered output contains a sequential 01/02/03-style section treatment; this is a common interchangeable editorial/AI convention and must be justified by project evidence",
        forbidden(policy, ["01/02/03", "numbered", "decorative 01", "numeración", "numbering"]) ? "BLOCK" : "WARN",
      ));
    }

    const arrowCount = countMatches(text, /[→←↑↓]/g);
    if (arrowCount >= 3) {
      findings.push(finding(
        "DECORATIVE_ARROWS",
        `rendered output repeats ${arrowCount} arrow glyphs; repeated arrows are treated as a generic decorative convention unless they are explicitly functional`,
        forbidden(policy, ["arrow", "flecha", "glyph"]) ? "BLOCK" : "WARN",
      ));
    }

    if (hasGenericSectionStack(artifact.html)) {
      findings.push(finding("GENERIC_SECTION_STACK", "rendered structure matches a conventional navigation/hero/features-or-gallery/contact/footer stack", "WARN"));
    }

    const eyebrowCount = countMatches(artifact.html.toLowerCase(), /class=["'][^"']*\b(?:eyebrow|kicker)\b[^"']*["']/g);
    if (eyebrowCount >= 3) {
      findings.push(finding("REPEATED_EYEBROW_LABELS", `rendered output repeats ${eyebrowCount} eyebrow/kicker labels, a common templated hierarchy signal`, "WARN"));
    }

    if (hasGenericCardGrid(artifact.html, css)) {
      findings.push(finding("GENERIC_CARD_GRID", "rendered output combines at least three card primitives with a grid surface", "WARN"));
    }

    const gradientCount = countMatches(css, /(?:linear|radial|conic)-gradient\s*\(/gi);
    if (gradientCount >= 2) {
      findings.push(finding("GENERIC_GRADIENT_SURFACE", `stylesheet contains ${gradientCount} gradient surfaces; repeated gradients require project-specific justification`, "WARN"));
    }

    const warningCodes = new Set(findings.filter((item) => item.severity === "WARN").map((item) => item.code));
    const blocks = findings.filter((item) => item.severity === "BLOCK");
    if ((policy.failOnGenericCombination ?? true) && blocks.length === 0 && warningCodes.size >= 2) {
      findings.push(finding("GENERIC_SECTION_STACK", `multiple independent generic fingerprint signals are present (${[...warningCodes].sort(lexicalCompare).join(", ")})`));
    }

    const hasBlock = findings.some((item) => item.severity === "BLOCK");
    const hasWarn = findings.some((item) => item.severity === "WARN");
    const verdict: VerdictState = hasBlock ? "FAIL" : hasWarn ? "WARNING" : "PASS";
    return Object.freeze({
      authority: "NEXUS_ARTIFACT_FINGERPRINT_CRITIC",
      verdict,
      approved: verdict === "PASS",
      findings: Object.freeze(findings.sort((a, b) => lexicalCompare(a.code, b.code))),
    });
  }
}
