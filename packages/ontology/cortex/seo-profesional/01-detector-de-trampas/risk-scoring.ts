import { createHmac, randomUUID } from "node:crypto";
import {
  computeRiskNetworkKeyHash,
  signRiskPayload,
  type SignedRiskEnvelope,
} from "../../fraud-risk-gate/index.js";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const CLICK_ID = /^\S{8,256}$/u;
const REPLAY_KEY = /^[0-9a-f]{64}$/u;
const AUTOMATION_UA = /(headlesschrome|phantomjs|selenium|playwright|puppeteer|python-requests|python\/\d|curl\/|wget\/|go-http-client|node-fetch|undici)/iu;
const PREFETCH = /(prefetch|prerender)/iu;

export type NetworkRiskClass = "RESIDENTIAL" | "MOBILE" | "BUSINESS" | "DATACENTER" | "VPN" | "TOR" | "UNKNOWN";
export type GoogleClickIdKind = "gclid" | "gbraid" | "wbraid";

export type InvalidTrafficSignalCode =
  | "NETWORK_TOR"
  | "NETWORK_DATACENTER"
  | "NETWORK_VPN"
  | "NETWORK_UNKNOWN"
  | "MISSING_USER_AGENT"
  | "AUTOMATION_USER_AGENT"
  | "PREFETCH_OR_PRERENDER"
  | "NON_GET_LANDING_REQUEST"
  | "HEAD_LANDING_REQUEST"
  | "NON_DOCUMENT_FETCH_DEST"
  | "NON_NAVIGATION_FETCH_MODE"
  | "HTML_NOT_ACCEPTED"
  | "MALFORMED_GOOGLE_CLICK_ID"
  | "MULTIPLE_GOOGLE_CLICK_IDS"
  | "REPLAYED_GOOGLE_CLICK_ID";

export interface InvalidTrafficSignal {
  readonly code: InvalidTrafficSignalCode;
  readonly points: number;
}

export interface CidrNetworkRule {
  readonly id: string;
  readonly cidr: string;
  readonly networkClass: NetworkRiskClass;
}

interface ParsedIp {
  readonly family: 4 | 6;
  readonly value: bigint;
}

interface ParsedNetworkRule extends CidrNetworkRule {
  readonly family: 4 | 6;
  readonly network: bigint;
  readonly prefixLength: number;
  readonly bitLength: 32 | 128;
}

export interface NetworkClassification {
  readonly networkClass: NetworkRiskClass;
  readonly matchedRuleId: string | null;
}

export type TrafficHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface InvalidTrafficClickInput {
  readonly url: string | URL;
  readonly clientIp: string;
  readonly networkKey?: string;
  readonly method?: string;
  readonly headers: TrafficHeaders;
}

export interface ClickReplayStore {
  seenOrRemember(key: string, nowMs: number, ttlMs: number): Promise<boolean>;
}

export interface InvalidTrafficScorerConfig {
  readonly signingSecret: string;
  readonly networkSecret: string;
  readonly clickReplaySecret: string;
  readonly providerId: string;
  readonly networkClassifier?: CidrNetworkClassifier;
  readonly replayStore?: ClickReplayStore;
  readonly assessmentTtlMs?: number;
  readonly replayTtlMs?: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export interface InvalidTrafficAssessment {
  readonly assessmentId: string;
  readonly assessedAt: string;
  readonly expiresAt: string;
  readonly riskScore: number;
  readonly networkClass: NetworkRiskClass;
  readonly matchedNetworkRuleId: string | null;
  readonly hasGoogleClickId: boolean;
  readonly googleClickIdKind: GoogleClickIdKind | null;
  readonly signals: readonly InvalidTrafficSignal[];
  readonly envelope: SignedRiskEnvelope;
}

export class InvalidTrafficScoringError extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "INVALID_INPUT", message: string) {
    super(message);
    this.name = "InvalidTrafficScoringError";
  }
}

function parseIpv4(value: string): bigint | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

function parseIpv6(value: string): bigint | null {
  if (!value || value.includes("%")) return null;
  let normalized = value.toLowerCase();

  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon < 0) return null;
    const embedded = parseIpv4(normalized.slice(lastColon + 1));
    if (embedded === null) return null;
    const high = Number((embedded >> 16n) & 0xffffn).toString(16);
    const low = Number(embedded & 0xffffn).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`;
  }

  const compressed = normalized.split("::");
  if (compressed.length > 2) return null;

  let groups: string[];
  if (compressed.length === 2) {
    const left = compressed[0] ? compressed[0].split(":") : [];
    const right = compressed[1] ? compressed[1].split(":") : [];
    if (left.some((part) => !part) || right.some((part) => !part)) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  } else {
    groups = normalized.split(":");
    if (groups.length !== 8 || groups.some((part) => !part)) return null;
  }

  if (groups.length !== 8) return null;
  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/u.test(group)) return null;
    result = (result << 16n) | BigInt(`0x${group}`);
  }
  return result;
}

function parseIp(value: string): ParsedIp {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\r\n\0]/u.test(normalized)) {
    throw new InvalidTrafficScoringError("INVALID_INPUT", "clientIp is malformed");
  }
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== null) return Object.freeze({ family: 4, value: ipv4 });
  const ipv6 = parseIpv6(normalized);
  if (ipv6 !== null) return Object.freeze({ family: 6, value: ipv6 });
  throw new InvalidTrafficScoringError("INVALID_INPUT", "clientIp is not a canonical IPv4 or IPv6 address");
}

function parseCidr(rule: CidrNetworkRule): ParsedNetworkRule {
  if (!rule.id || rule.id.length > 128 || /[\r\n\0]/u.test(rule.id)) throw new InvalidTrafficScoringError("INVALID_CONFIG", "CIDR rule id is malformed");
  if (!(rule.networkClass === "RESIDENTIAL" || rule.networkClass === "MOBILE" || rule.networkClass === "BUSINESS" || rule.networkClass === "DATACENTER" || rule.networkClass === "VPN" || rule.networkClass === "TOR" || rule.networkClass === "UNKNOWN")) {
    throw new InvalidTrafficScoringError("INVALID_CONFIG", `CIDR rule ${rule.id} has an invalid networkClass`);
  }
  const parts = rule.cidr.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1] || !/^\d{1,3}$/u.test(parts[1])) throw new InvalidTrafficScoringError("INVALID_CONFIG", `CIDR rule ${rule.id} is malformed`);
  const parsed = parseIp(parts[0]);
  const prefixLength = Number(parts[1]);
  const bitLength = parsed.family === 4 ? 32 : 128;
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > bitLength) throw new InvalidTrafficScoringError("INVALID_CONFIG", `CIDR rule ${rule.id} prefix is invalid`);
  const hostBits = BigInt(bitLength - prefixLength);
  const network = hostBits === 0n ? parsed.value : (parsed.value >> hostBits) << hostBits;
  return Object.freeze({ ...rule, family: parsed.family, network, prefixLength, bitLength });
}

export class CidrNetworkClassifier {
  private readonly rules: readonly ParsedNetworkRule[];

  constructor(rules: readonly CidrNetworkRule[] = []) {
    if (rules.length > 100_000) throw new InvalidTrafficScoringError("INVALID_CONFIG", "CIDR rule set is too large");
    const ids = new Set<string>();
    const parsed = rules.map((rule) => {
      if (ids.has(rule.id)) throw new InvalidTrafficScoringError("INVALID_CONFIG", `duplicate CIDR rule id ${rule.id}`);
      ids.add(rule.id);
      return parseCidr(rule);
    });
    this.rules = Object.freeze(parsed.sort((left, right) => right.prefixLength - left.prefixLength));
  }

  classify(ip: string): NetworkClassification {
    const parsed = parseIp(ip);
    for (const rule of this.rules) {
      if (rule.family !== parsed.family) continue;
      const hostBits = BigInt(rule.bitLength - rule.prefixLength);
      const network = hostBits === 0n ? parsed.value : (parsed.value >> hostBits) << hostBits;
      if (network === rule.network) return Object.freeze({ networkClass: rule.networkClass, matchedRuleId: rule.id });
    }
    return Object.freeze({ networkClass: "UNKNOWN", matchedRuleId: null });
  }
}

export class BoundedMemoryClickReplayStore implements ClickReplayStore {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries = 50_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 100 || maxEntries > 1_000_000) throw new InvalidTrafficScoringError("INVALID_CONFIG", "maxEntries must be 100..1000000");
  }

  async seenOrRemember(key: string, nowMs: number, ttlMs: number): Promise<boolean> {
    if (!REPLAY_KEY.test(key)) throw new InvalidTrafficScoringError("INVALID_INPUT", "replay key is malformed");
    if (!Number.isFinite(nowMs) || !Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) throw new InvalidTrafficScoringError("INVALID_INPUT", "replay timing is invalid");

    for (;;) {
      const oldest = this.entries.entries().next();
      if (oldest.done) break;
      const [oldestKey, expiresAt] = oldest.value;
      if (expiresAt > nowMs && this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldestKey);
    }

    const existing = this.entries.get(key);
    if (existing !== undefined && existing > nowMs) return true;
    if (existing !== undefined) this.entries.delete(key);

    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, nowMs + ttlMs);
    return false;
  }
}

function normalizeSecret(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new InvalidTrafficScoringError("INVALID_CONFIG", `${label} must be 32..4096 safe characters`);
  return value;
}

function headerMap(input: TrafficHeaders): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  let totalBytes = 0;
  let count = 0;

  const append = (nameInput: string, valueInput: string): void => {
    const name = nameInput.toLowerCase();
    if (!name || name.length > 128 || /[\r\n\0]/u.test(name) || /[\r\n\0]/u.test(valueInput)) throw new InvalidTrafficScoringError("INVALID_INPUT", "request headers are malformed");
    count += 1;
    totalBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(valueInput, "utf8");
    if (count > 256 || totalBytes > 64 * 1024) throw new InvalidTrafficScoringError("INVALID_INPUT", "request headers exceed scoring bounds");
    const previous = result.get(name);
    result.set(name, previous === undefined ? valueInput : `${previous}, ${valueInput}`);
  };

  if (input instanceof Headers) {
    for (const [name, value] of input.entries()) append(name, value);
  } else {
    for (const [name, value] of Object.entries(input)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) append(name, item);
      else append(name, value);
    }
  }
  return result;
}

function absoluteUrl(value: string | URL): URL {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password || url.href.length > 8_192) throw new InvalidTrafficScoringError("INVALID_INPUT", "landing URL is malformed or unsupported");
  return url;
}

interface GoogleClickInspection {
  readonly kind: GoogleClickIdKind | null;
  readonly value: string | null;
  readonly malformed: boolean;
  readonly multiple: boolean;
}

function inspectGoogleClickId(url: URL): GoogleClickInspection {
  const kinds = ["gclid", "gbraid", "wbraid"] as const;
  const entries: { kind: GoogleClickIdKind; value: string }[] = [];
  let malformed = false;
  for (const kind of kinds) {
    const values = url.searchParams.getAll(kind);
    if (values.length > 1) malformed = true;
    for (const value of values) entries.push({ kind, value });
  }
  const multiple = entries.length > 1;
  if (multiple) return Object.freeze({ kind: null, value: null, malformed, multiple: true });
  if (entries.length === 0) return Object.freeze({ kind: null, value: null, malformed: false, multiple: false });
  const entry = entries[0]!;
  if (!CLICK_ID.test(entry.value)) malformed = true;
  return Object.freeze({ kind: malformed ? null : entry.kind, value: malformed ? null : entry.value, malformed, multiple: false });
}

function networkPoints(networkClass: NetworkRiskClass): InvalidTrafficSignal | null {
  if (networkClass === "TOR") return Object.freeze({ code: "NETWORK_TOR", points: 850 });
  if (networkClass === "DATACENTER") return Object.freeze({ code: "NETWORK_DATACENTER", points: 500 });
  if (networkClass === "VPN") return Object.freeze({ code: "NETWORK_VPN", points: 250 });
  if (networkClass === "UNKNOWN") return Object.freeze({ code: "NETWORK_UNKNOWN", points: 60 });
  return null;
}

function addSignal(signals: InvalidTrafficSignal[], code: InvalidTrafficSignalCode, points: number): void {
  signals.push(Object.freeze({ code, points }));
}

function boundedMs(value: number | undefined, fallback: number, label: string, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new InvalidTrafficScoringError("INVALID_CONFIG", `${label} is out of range`);
  return resolved;
}

export class InvalidTrafficClickScorer {
  private readonly signingSecret: string;
  private readonly networkSecret: string;
  private readonly clickReplaySecret: string;
  private readonly providerId: string;
  private readonly networkClassifier: CidrNetworkClassifier;
  private readonly replayStore: ClickReplayStore;
  private readonly assessmentTtlMs: number;
  private readonly replayTtlMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(config: InvalidTrafficScorerConfig) {
    this.signingSecret = normalizeSecret(config.signingSecret, "signingSecret");
    this.networkSecret = normalizeSecret(config.networkSecret, "networkSecret");
    this.clickReplaySecret = normalizeSecret(config.clickReplaySecret, "clickReplaySecret");
    if (this.signingSecret === this.networkSecret || this.signingSecret === this.clickReplaySecret || this.networkSecret === this.clickReplaySecret) throw new InvalidTrafficScoringError("INVALID_CONFIG", "scoring secrets must be distinct");
    if (!PROVIDER_ID.test(config.providerId)) throw new InvalidTrafficScoringError("INVALID_CONFIG", "providerId is malformed");
    this.providerId = config.providerId;
    this.networkClassifier = config.networkClassifier ?? new CidrNetworkClassifier();
    this.replayStore = config.replayStore ?? new BoundedMemoryClickReplayStore();
    this.assessmentTtlMs = boundedMs(config.assessmentTtlMs, 30_000, "assessmentTtlMs", 1_000, 300_000);
    this.replayTtlMs = boundedMs(config.replayTtlMs, 15 * 60_000, "replayTtlMs", 1_000, 86_400_000);
    this.now = config.now ?? Date.now;
    this.idFactory = config.idFactory ?? randomUUID;
  }

  async assess(input: InvalidTrafficClickInput): Promise<InvalidTrafficAssessment> {
    const nowMs = this.now();
    if (!Number.isFinite(nowMs)) throw new InvalidTrafficScoringError("INVALID_INPUT", "clock returned a non-finite timestamp");
    const url = absoluteUrl(input.url);
    const classification = this.networkClassifier.classify(input.clientIp);
    const headers = headerMap(input.headers);
    const method = (input.method ?? "GET").toUpperCase();
    if (!/^[A-Z]{3,16}$/u.test(method)) throw new InvalidTrafficScoringError("INVALID_INPUT", "request method is malformed");
    const click = inspectGoogleClickId(url);
    const signals: InvalidTrafficSignal[] = [];

    const networkSignal = networkPoints(classification.networkClass);
    if (networkSignal) signals.push(networkSignal);

    const userAgent = headers.get("user-agent")?.trim() ?? "";
    if (!userAgent) addSignal(signals, "MISSING_USER_AGENT", 350);
    else if (AUTOMATION_UA.test(userAgent)) addSignal(signals, "AUTOMATION_USER_AGENT", 500);

    const purpose = `${headers.get("purpose") ?? ""} ${headers.get("sec-purpose") ?? ""}`;
    if (PREFETCH.test(purpose)) addSignal(signals, "PREFETCH_OR_PRERENDER", 700);

    if (method === "HEAD") addSignal(signals, "HEAD_LANDING_REQUEST", 300);
    else if (method !== "GET") addSignal(signals, "NON_GET_LANDING_REQUEST", 500);

    const fetchDest = headers.get("sec-fetch-dest")?.trim().toLowerCase();
    if (fetchDest && fetchDest !== "document") addSignal(signals, "NON_DOCUMENT_FETCH_DEST", 250);
    const fetchMode = headers.get("sec-fetch-mode")?.trim().toLowerCase();
    if (fetchMode && fetchMode !== "navigate") addSignal(signals, "NON_NAVIGATION_FETCH_MODE", 250);

    const accept = headers.get("accept")?.toLowerCase();
    if (accept && !accept.includes("text/html") && !accept.includes("*/*")) addSignal(signals, "HTML_NOT_ACCEPTED", 120);

    if (click.multiple) addSignal(signals, "MULTIPLE_GOOGLE_CLICK_IDS", 650);
    if (click.malformed) addSignal(signals, "MALFORMED_GOOGLE_CLICK_ID", 700);

    if (click.kind && click.value) {
      const replayKey = createHmac("sha256", this.clickReplaySecret).update(`${click.kind}\0${click.value}`, "utf8").digest("hex");
      if (await this.replayStore.seenOrRemember(replayKey, nowMs, this.replayTtlMs)) addSignal(signals, "REPLAYED_GOOGLE_CLICK_ID", 350);
    }

    const riskScore = Math.min(1_000, signals.reduce((sum, signal) => sum + signal.points, 0));
    const assessmentId = this.idFactory();
    if (!PROVIDER_ID.test(assessmentId)) throw new InvalidTrafficScoringError("INVALID_INPUT", "idFactory returned a malformed assessmentId");
    const assessedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + this.assessmentTtlMs).toISOString();
    const networkKey = input.networkKey ?? input.clientIp.trim();
    const networkKeyHash = computeRiskNetworkKeyHash(networkKey, this.networkSecret);
    const envelope = signRiskPayload({
      schemaVersion: 1,
      assessmentId,
      providerId: this.providerId,
      assessedAt,
      expiresAt,
      riskScore,
      networkKeyHash,
    }, this.signingSecret);

    return Object.freeze({
      assessmentId,
      assessedAt,
      expiresAt,
      riskScore,
      networkClass: classification.networkClass,
      matchedNetworkRuleId: classification.matchedRuleId,
      hasGoogleClickId: click.kind !== null,
      googleClickIdKind: click.kind,
      signals: Object.freeze(signals),
      envelope,
    });
  }
}
