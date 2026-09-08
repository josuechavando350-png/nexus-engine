export class RobotsPolicyError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "MALFORMED_POLICY", message: string) {
    super(message);
    this.name = "RobotsPolicyError";
  }
}

export interface RobotsDecision {
  readonly allowed: boolean;
  readonly matchedRule: string | null;
  readonly matchedUserAgent: string;
}

interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
  readonly specificity: number;
}

interface RobotsGroup {
  readonly userAgents: readonly string[];
  readonly rules: readonly RobotsRule[];
}

const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_LINE_LENGTH = 8 * 1024;
const MAX_GROUPS = 256;
const MAX_RULES = 4096;

function assertNoForbiddenControls(value: string, label: string): void {
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      throw new RobotsPolicyError("MALFORMED_POLICY", `${label} contains forbidden control characters`);
    }
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizePercentOctets(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === "%" && i + 2 < value.length) {
      const pair = value.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/u.test(pair)) {
        const byte = Number.parseInt(pair, 16);
        const decoded = String.fromCharCode(byte);
        if (/^[A-Za-z0-9\-._~]$/u.test(decoded)) out += decoded;
        else out += `%${pair.toUpperCase()}`;
        i += 2;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function globToRegExp(pattern: string): RegExp {
  const anchoredEnd = pattern.endsWith("$");
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
  let source = "^";
  for (const ch of body) {
    if (ch === "*") source += ".*";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  if (anchoredEnd) source += "$";
  return new RegExp(source, "u");
}

function parse(text: string): readonly RobotsGroup[] {
  if (utf8Length(text) > MAX_ROBOTS_BYTES) throw new RobotsPolicyError("MALFORMED_POLICY", "robots.txt exceeds the 512 KiB policy bound");
  assertNoForbiddenControls(text, "robots.txt");

  const groups: RobotsGroup[] = [];
  let agents: string[] = [];
  let rules: RobotsRule[] = [];
  let sawRule = false;
  let totalRules = 0;

  const flush = (): void => {
    if (agents.length === 0) return;
    groups.push(Object.freeze({ userAgents: Object.freeze([...agents]), rules: Object.freeze([...rules]) }));
    if (groups.length > MAX_GROUPS) throw new RobotsPolicyError("MALFORMED_POLICY", "robots.txt has too many groups");
    agents = [];
    rules = [];
    sawRule = false;
  };

  for (const rawLine of text.replace(/\r\n?/gu, "\n").split("\n")) {
    if (utf8Length(rawLine) > MAX_LINE_LENGTH) throw new RobotsPolicyError("MALFORMED_POLICY", "robots.txt contains an oversized line");
    const commentIndex = rawLine.indexOf("#");
    const line = (commentIndex >= 0 ? rawLine.slice(0, commentIndex) : rawLine).trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      const token = value.toLowerCase();
      if (!token || /\s/u.test(token)) continue;
      if (sawRule) flush();
      agents.push(token);
      continue;
    }
    if ((field === "allow" || field === "disallow") && agents.length > 0) {
      sawRule = true;
      if (!value) continue;
      const normalized = normalizePercentOctets(value);
      const specificity = utf8Length(normalized.replace(/\*/gu, "").replace(/\$$/u, ""));
      rules.push(Object.freeze({ allow: field === "allow", pattern: normalized, specificity }));
      totalRules += 1;
      if (totalRules > MAX_RULES) throw new RobotsPolicyError("MALFORMED_POLICY", "robots.txt has too many rules");
    }
  }
  flush();
  return Object.freeze(groups);
}

function matchingGroups(groups: readonly RobotsGroup[], userAgent: string): readonly RobotsGroup[] {
  const token = userAgent.toLowerCase().trim();
  if (!token || /\s/u.test(token)) throw new RobotsPolicyError("INVALID_INPUT", "crawler user-agent must be one product token");
  const exact = groups.filter((group) => group.userAgents.includes(token));
  if (exact.length > 0) return exact;
  return groups.filter((group) => group.userAgents.includes("*"));
}

export class RobotsPolicy {
  private readonly groups: readonly RobotsGroup[];

  constructor(text: string) {
    if (typeof text !== "string") throw new RobotsPolicyError("INVALID_INPUT", "robots.txt must be text");
    this.groups = parse(text);
  }

  decide(userAgent: string, target: URL): RobotsDecision {
    if (!(target instanceof URL) || (target.protocol !== "https:" && target.protocol !== "http:")) {
      throw new RobotsPolicyError("INVALID_INPUT", "robots decision requires an HTTP(S) URL");
    }
    const path = normalizePercentOctets(`${target.pathname}${target.search}` || "/");
    const candidates = matchingGroups(this.groups, userAgent).flatMap((group) => group.rules)
      .filter((rule) => globToRegExp(rule.pattern).test(path));
    if (candidates.length === 0) return Object.freeze({ allowed: true, matchedRule: null, matchedUserAgent: userAgent.toLowerCase() });
    candidates.sort((left, right) => right.specificity - left.specificity || Number(right.allow) - Number(left.allow));
    const winner = candidates[0]!;
    return Object.freeze({ allowed: winner.allow, matchedRule: winner.pattern, matchedUserAgent: userAgent.toLowerCase() });
  }
}
