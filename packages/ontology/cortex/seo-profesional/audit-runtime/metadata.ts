import type { SeoAuditIssue, SeoAuditPageSnapshot } from "./contracts.js";
import { FirstPartySeoAuditUrlPolicy } from "./url-policy.js";

function directives(value: string | null): ReadonlySet<string> {
  if (!value) return new Set<string>();
  return new Set(value.toLowerCase().split(/[\s,;]+/u).map((part) => part.trim()).filter(Boolean));
}

function issue(input: Omit<SeoAuditIssue, "url"> & { readonly url: string }): SeoAuditIssue {
  return Object.freeze({ ...input });
}

export function analyzePageSnapshot(snapshot: SeoAuditPageSnapshot, policy: FirstPartySeoAuditUrlPolicy): Readonly<{
  indexable: boolean;
  issues: readonly SeoAuditIssue[];
}> {
  const issues: SeoAuditIssue[] = [];
  const robots = directives(snapshot.robotsMeta);
  const xRobots = directives(snapshot.xRobotsTag);
  const hasNoindex = robots.has("noindex") || robots.has("none") || xRobots.has("noindex") || xRobots.has("none");
  const success = snapshot.status >= 200 && snapshot.status < 300;
  const indexable = success && !hasNoindex;

  if (!success) {
    issues.push(issue({
      code: "NON_2XX_STATUS",
      severity: "ERROR",
      category: "INDEXABILITY",
      url: snapshot.finalUrl,
      message: `Final page returned HTTP ${snapshot.status}; it is not considered indexable by this audit.`,
      evidence: Object.freeze({ status: snapshot.status }),
    }));
  }

  if (hasNoindex) {
    issues.push(issue({ code: "NOINDEX_DIRECTIVE", severity: "WARNING", category: "INDEXABILITY", url: snapshot.finalUrl, message: "The page carries a noindex directive." }));
  }

  const title = snapshot.title.trim();
  if (!title) {
    issues.push(issue({ code: "TITLE_MISSING", severity: "ERROR", category: "METADATA", url: snapshot.finalUrl, message: "Page title is missing." }));
  } else if (title.length < 15 || title.length > 65) {
    issues.push(issue({
      code: "TITLE_LENGTH",
      severity: "WARNING",
      category: "METADATA",
      url: snapshot.finalUrl,
      message: `Page title length is ${title.length} characters; review SERP fit and clarity.`,
      evidence: Object.freeze({ characters: title.length }),
    }));
  }

  const description = snapshot.description?.trim() ?? "";
  if (!description) {
    issues.push(issue({ code: "META_DESCRIPTION_MISSING", severity: "WARNING", category: "METADATA", url: snapshot.finalUrl, message: "Meta description is missing." }));
  } else if (description.length < 50 || description.length > 165) {
    issues.push(issue({
      code: "META_DESCRIPTION_LENGTH",
      severity: "INFO",
      category: "METADATA",
      url: snapshot.finalUrl,
      message: `Meta description length is ${description.length} characters; review whether it communicates the page intent efficiently.`,
      evidence: Object.freeze({ characters: description.length }),
    }));
  }

  const h1s = snapshot.headings.filter((heading) => heading.level === 1 && heading.text.trim());
  if (h1s.length === 0) {
    issues.push(issue({ code: "H1_MISSING", severity: "WARNING", category: "CONTENT", url: snapshot.finalUrl, message: "No non-empty H1 was found." }));
  } else if (h1s.length > 1) {
    issues.push(issue({
      code: "MULTIPLE_H1",
      severity: "INFO",
      category: "CONTENT",
      url: snapshot.finalUrl,
      message: `The page contains ${h1s.length} H1 headings; confirm the document hierarchy is intentional.`,
      evidence: Object.freeze({ h1Count: h1s.length }),
    }));
  }

  if (!snapshot.language?.trim()) {
    issues.push(issue({ code: "HTML_LANG_MISSING", severity: "WARNING", category: "METADATA", url: snapshot.finalUrl, message: "The root html element does not declare a language." }));
  }

  if (!snapshot.canonical) {
    issues.push(issue({ code: "CANONICAL_MISSING", severity: "WARNING", category: "INDEXABILITY", url: snapshot.finalUrl, message: "Canonical link is missing." }));
  } else {
    try {
      const canonical = new URL(snapshot.canonical, snapshot.finalUrl);
      if (canonical.origin !== policy.origin) {
        issues.push(issue({
          code: "CANONICAL_CROSS_ORIGIN",
          severity: "WARNING",
          category: "INDEXABILITY",
          url: snapshot.finalUrl,
          message: "Canonical points outside the configured first-party origin.",
          evidence: Object.freeze({ canonical: canonical.toString() }),
        }));
      } else {
        canonical.hash = "";
        const current = new URL(snapshot.finalUrl);
        current.hash = "";
        if (canonical.toString() !== current.toString()) {
          issues.push(issue({
            code: "CANONICAL_NOT_SELF",
            severity: "INFO",
            category: "INDEXABILITY",
            url: snapshot.finalUrl,
            message: "Canonical points to a different first-party URL; verify duplicate-content intent.",
            evidence: Object.freeze({ canonical: canonical.toString() }),
          }));
        }
      }
    } catch {
      issues.push(issue({ code: "CANONICAL_INVALID", severity: "ERROR", category: "INDEXABILITY", url: snapshot.finalUrl, message: "Canonical URL is malformed." }));
    }
  }

  if (snapshot.textLength < 200) {
    issues.push(issue({
      code: "THIN_VISIBLE_TEXT",
      severity: "INFO",
      category: "CONTENT",
      url: snapshot.finalUrl,
      message: `Only ${snapshot.textLength} visible text characters were observed; review whether the page satisfies its search intent.`,
      evidence: Object.freeze({ textCharacters: snapshot.textLength }),
    }));
  }

  const missingAlt = snapshot.images.filter((image) => image.alt === null).length;
  if (missingAlt > 0) {
    issues.push(issue({
      code: "IMAGE_ALT_MISSING",
      severity: "WARNING",
      category: "CONTENT",
      url: snapshot.finalUrl,
      message: `${missingAlt} image(s) are missing an alt attribute.`,
      evidence: Object.freeze({ missingAlt }),
    }));
  }

  for (const [index, block] of snapshot.jsonLdBlocks.entries()) {
    try {
      const parsed: unknown = JSON.parse(block);
      if (!parsed || (typeof parsed !== "object" && !Array.isArray(parsed))) throw new Error("not an object or array");
    } catch {
      issues.push(issue({
        code: "JSON_LD_INVALID",
        severity: "ERROR",
        category: "STRUCTURED_DATA",
        url: snapshot.finalUrl,
        message: `JSON-LD block ${index + 1} is not valid JSON object/array data.`,
        evidence: Object.freeze({ block: index + 1 }),
      }));
    }
  }

  if (snapshot.responseTimeMs > 3_000) {
    issues.push(issue({
      code: "SLOW_DOCUMENT_RESPONSE",
      severity: "WARNING",
      category: "CRAWL",
      url: snapshot.finalUrl,
      message: `Document navigation took ${snapshot.responseTimeMs} ms in the audit browser.`,
      evidence: Object.freeze({ responseTimeMs: snapshot.responseTimeMs }),
    }));
  }

  return Object.freeze({ indexable, issues: Object.freeze(issues) });
}
