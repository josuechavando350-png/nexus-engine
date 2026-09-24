#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED = Object.freeze({
  schemaVersion: 1,
  tournamentId: "CANO_PENAL_CDMX_ZERO",
  siteId: "cano-penal",
  siteHostname: "canopenal.com",
  market: Object.freeze({
    country: "Mexico",
    region: "Ciudad de México",
    language: "es-MX",
  }),
  priorTournamentReuse: "FORBIDDEN",
  productionMutation: "FORBIDDEN",
});

const AUDIT_EVIDENCE_CLASS = "USER_SUPPLIED_MARKET_AUDIT";

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.normalize("NFC").trim();
}

function exactKeys(value, expected, name) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${name} has missing or unexpected fields`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

export function validateCanoTournamentIdentity(raw) {
  const identity = object(raw, "CANO tournament identity");
  exactKeys(identity, [
    "schemaVersion",
    "tournamentId",
    "siteId",
    "siteHostname",
    "market",
    "priorTournamentReuse",
    "productionMutation",
  ], "CANO tournament identity");

  const market = object(identity.market, "identity.market");
  exactKeys(market, ["country", "region", "language"], "identity.market");

  const normalized = {
    schemaVersion: identity.schemaVersion,
    tournamentId: text(identity.tournamentId, "identity.tournamentId"),
    siteId: text(identity.siteId, "identity.siteId"),
    siteHostname: text(identity.siteHostname, "identity.siteHostname").toLowerCase(),
    market: {
      country: text(market.country, "identity.market.country"),
      region: text(market.region, "identity.market.region"),
      language: text(market.language, "identity.market.language"),
    },
    priorTournamentReuse: text(identity.priorTournamentReuse, "identity.priorTournamentReuse"),
    productionMutation: text(identity.productionMutation, "identity.productionMutation"),
  };

  if (canonicalJson(normalized) !== canonicalJson(EXPECTED)) {
    throw new Error("CANO_TOURNAMENT_IDENTITY_MISMATCH");
  }
  return deepFreeze(normalized);
}

export function validateCanoAuditManifest(raw, identity, auditBytes) {
  const manifest = object(raw, "audit manifest");
  exactKeys(manifest, [
    "schemaVersion",
    "tournamentId",
    "siteId",
    "siteHostname",
    "evidenceClass",
    "evidenceLabel",
    "evidenceSha256",
  ], "audit manifest");

  if (!(auditBytes instanceof Uint8Array) || auditBytes.byteLength === 0) {
    throw new Error("AUDIT_BYTES_REQUIRED");
  }
  if (manifest.schemaVersion !== 1) throw new Error("unsupported audit manifest schemaVersion");
  if (text(manifest.tournamentId, "manifest.tournamentId") !== identity.tournamentId) {
    throw new Error("CROSS_TENANT_TOURNAMENT_ID_MISMATCH");
  }
  if (text(manifest.siteId, "manifest.siteId") !== identity.siteId) {
    throw new Error("CROSS_TENANT_SITE_ID_MISMATCH");
  }
  if (text(manifest.siteHostname, "manifest.siteHostname").toLowerCase() !== identity.siteHostname) {
    throw new Error("CROSS_TENANT_SITE_HOSTNAME_MISMATCH");
  }
  if (text(manifest.evidenceClass, "manifest.evidenceClass") !== AUDIT_EVIDENCE_CLASS) {
    throw new Error("AUDIT_EVIDENCE_CLASS_NOT_ALLOWED");
  }

  const evidenceLabel = text(manifest.evidenceLabel, "manifest.evidenceLabel");
  const evidenceSha256 = text(manifest.evidenceSha256, "manifest.evidenceSha256").toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(evidenceSha256)) {
    throw new Error("AUDIT_SHA256_FORMAT_INVALID");
  }
  const actualSha256 = sha256Bytes(auditBytes);
  if (evidenceSha256 !== actualSha256) {
    throw new Error("AUDIT_SHA256_MISMATCH");
  }

  return deepFreeze({
    schemaVersion: 1,
    tournamentId: identity.tournamentId,
    siteId: identity.siteId,
    siteHostname: identity.siteHostname,
    evidenceClass: AUDIT_EVIDENCE_CLASS,
    evidenceLabel,
    evidenceSha256,
  });
}

export function buildCanoTournamentZero(rawIdentity, { auditManifest = null, auditBytes = null } = {}) {
  const identity = validateCanoTournamentIdentity(rawIdentity);
  let audit = null;
  let status = "READY_FOR_AUDIT";

  if (auditManifest !== null || auditBytes !== null) {
    if (auditManifest === null || auditBytes === null) {
      throw new Error("AUDIT_AND_MANIFEST_MUST_BE_SUPPLIED_TOGETHER");
    }
    audit = validateCanoAuditManifest(auditManifest, identity, auditBytes);
    status = "AUDIT_BOUND_STRATEGY_GENERATION_PENDING";
  }

  const unsigned = {
    schemaVersion: 1,
    tournamentId: identity.tournamentId,
    identity,
    status,
    evidence: audit ? [audit] : [],
    priorTournamentInputs: [],
    strategies: [],
    strategyCount: 0,
    selectedStrategyId: null,
    commercialOutcomeClaim: "NOT_EVALUATED",
    productionMutation: "FORBIDDEN",
    nextGate: audit
      ? "GENERATE_STRATEGIES_FROM_BOUND_AUDIT_WITH_EXPLICIT_EVIDENCE"
      : "SUPPLY_AND_BIND_MARKET_AUDIT",
  };

  return deepFreeze({ ...unsigned, stateSha256: sha256Canonical(unsigned) });
}

function usage() {
  console.error("usage: node tournaments/cano-penal-zero/tournament-zero.mjs [--audit <path> --audit-manifest <path>]");
}

async function cli(argv) {
  let auditPath = null;
  let manifestPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--audit", "--audit-manifest"].includes(arg)) {
      usage();
      throw new Error(`unknown argument:${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      usage();
      throw new Error(`missing value for ${arg}`);
    }
    if (arg === "--audit") auditPath = resolve(value);
    if (arg === "--audit-manifest") manifestPath = resolve(value);
    index += 1;
  }
  if ((auditPath === null) !== (manifestPath === null)) {
    throw new Error("AUDIT_AND_MANIFEST_MUST_BE_SUPPLIED_TOGETHER");
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const identity = JSON.parse(await readFile(resolve(here, "identity.json"), "utf8"));
  const options = {};
  if (auditPath !== null) {
    options.auditBytes = await readFile(auditPath);
    options.auditManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  }
  process.stdout.write(`${JSON.stringify(buildCanoTournamentZero(identity, options), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((error) => {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}
