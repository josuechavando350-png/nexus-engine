import { createHash } from "node:crypto";

export type DetectedTechnologyCategory = "CMS" | "FRAMEWORK" | "COMMERCE" | "EDGE_HOSTING";
export type TechnologyEvidenceKind = "HEADER" | "META_GENERATOR" | "HTML_MARKER" | "ASSET_URL";

export interface PublicTechnologyEvidence {
  readonly status: number;
  readonly finalUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly html: string;
}

export interface DetectedTechnology {
  readonly name: string;
  readonly category: DetectedTechnologyCategory;
  readonly confidence: "HIGH" | "MEDIUM";
  readonly evidenceKinds: readonly TechnologyEvidenceKind[];
}

export interface TechnologyFingerprint {
  readonly technologies: readonly DetectedTechnology[];
  readonly evidenceDigest: string;
  readonly policyVersion: "seo8-passive-tech-v1";
}

interface RuleInput {
  readonly headers: Record<string, string>;
  readonly html: string;
  readonly generator: string;
}

type Rule = Readonly<{
  name: string;
  category: DetectedTechnologyCategory;
  confidence: "HIGH" | "MEDIUM";
  test: (input: RuleInput) => readonly TechnologyEvidenceKind[];
}>;

function evidence(...values: TechnologyEvidenceKind[]): readonly TechnologyEvidenceKind[] {
  return values;
}

const RULES: readonly Rule[] = Object.freeze([
  { name: "Cloudflare", category: "EDGE_HOSTING", confidence: "HIGH", test: ({ headers }: RuleInput) => headers["cf-ray"] || /cloudflare/iu.test(headers.server ?? "") ? evidence("HEADER") : evidence() },
  { name: "Vercel", category: "EDGE_HOSTING", confidence: "HIGH", test: ({ headers }: RuleInput) => headers["x-vercel-id"] ? evidence("HEADER") : evidence() },
  { name: "Netlify", category: "EDGE_HOSTING", confidence: "HIGH", test: ({ headers }: RuleInput) => headers["x-nf-request-id"] ? evidence("HEADER") : evidence() },
  { name: "WordPress", category: "CMS", confidence: "HIGH", test: ({ html, generator }: RuleInput) => {
    const kinds: TechnologyEvidenceKind[] = [];
    if (/wordpress/iu.test(generator)) kinds.push("META_GENERATOR");
    if (/\/(?:wp-content|wp-includes)\//iu.test(html)) kinds.push("ASSET_URL");
    return kinds;
  } },
  { name: "Shopify", category: "COMMERCE", confidence: "HIGH", test: ({ html, generator }: RuleInput) => {
    const kinds: TechnologyEvidenceKind[] = [];
    if (/shopify/iu.test(generator)) kinds.push("META_GENERATOR");
    if (/cdn\.shopify\.com|shopify-section/iu.test(html)) kinds.push("ASSET_URL");
    return kinds;
  } },
  { name: "Wix", category: "CMS", confidence: "HIGH", test: ({ html, generator }: RuleInput) => {
    const kinds: TechnologyEvidenceKind[] = [];
    if (/wix/iu.test(generator)) kinds.push("META_GENERATOR");
    if (/wixstatic\.com|wix-image/iu.test(html)) kinds.push("ASSET_URL");
    return kinds;
  } },
  { name: "Squarespace", category: "CMS", confidence: "HIGH", test: ({ html, generator }: RuleInput) => {
    const kinds: TechnologyEvidenceKind[] = [];
    if (/squarespace/iu.test(generator)) kinds.push("META_GENERATOR");
    if (/static1\.squarespace\.com|squarespace-cdn/iu.test(html)) kinds.push("ASSET_URL");
    return kinds;
  } },
  { name: "Next.js", category: "FRAMEWORK", confidence: "HIGH", test: ({ headers, html }: RuleInput) => {
    const kinds: TechnologyEvidenceKind[] = [];
    if (/next\.js/iu.test(headers["x-powered-by"] ?? "")) kinds.push("HEADER");
    if (/\/_next\/|__NEXT_DATA__/u.test(html)) kinds.push("ASSET_URL");
    return kinds;
  } },
  { name: "React", category: "FRAMEWORK", confidence: "MEDIUM", test: ({ html }: RuleInput) => /data-reactroot|data-reactid|react-dom/iu.test(html) ? evidence("HTML_MARKER") : evidence() },
] as const);

function metaGenerator(html: string): string {
  const patterns = [
    /<meta\s+[^>]*name=["']generator["'][^>]*content=["']([^"']{1,256})["'][^>]*>/iu,
    /<meta\s+[^>]*content=["']([^"']{1,256})["'][^>]*name=["']generator["'][^>]*>/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return match[1].normalize("NFKC").trim();
  }
  return "";
}

function normalizeHeaders(input: Readonly<Record<string, string>>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    output[name.toLowerCase()] = value.slice(0, 2_048);
  }
  return output;
}

export function fingerprintPublicTechnology(input: PublicTechnologyEvidence): TechnologyFingerprint {
  if (!input || typeof input !== "object" || !Number.isSafeInteger(input.status) || input.status < 100 || input.status > 599 || typeof input.finalUrl !== "string" || typeof input.html !== "string") {
    throw new TypeError("public technology evidence is invalid");
  }
  if (Buffer.byteLength(input.html, "utf8") > 1_048_576) throw new RangeError("public technology evidence exceeds passive fingerprint bounds");
  const headers = normalizeHeaders(input.headers);
  const generator = metaGenerator(input.html);
  const technologies: DetectedTechnology[] = [];
  for (const rule of RULES) {
    const kinds = [...new Set(rule.test({ headers, html: input.html, generator }))].sort();
    if (kinds.length === 0) continue;
    technologies.push(Object.freeze({ name: rule.name, category: rule.category, confidence: rule.confidence, evidenceKinds: Object.freeze(kinds) }));
  }
  technologies.sort((left, right) => left.name.localeCompare(right.name));
  const digestPayload = JSON.stringify({ status: input.status, finalUrl: input.finalUrl, headers, htmlDigest: createHash("sha256").update(input.html, "utf8").digest("hex"), technologies });
  return Object.freeze({
    technologies: Object.freeze(technologies),
    evidenceDigest: `sha256:${createHash("sha256").update(digestPayload, "utf8").digest("hex")}`,
    policyVersion: "seo8-passive-tech-v1" as const,
  });
}
