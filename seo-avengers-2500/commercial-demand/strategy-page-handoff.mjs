import { __test as tournamentTools } from "./tournament-engine-v2.mjs";

const HASH = /^sha256:[0-9a-f]{64}$/u;
const ACTIONS = new Set(["KEEP", "IMPROVE", "CREATE"]);
const APPROVAL = "APPROVED";
const NO_MUTATION = "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_VERCEL_OR_TENANT_MUTATION";

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function hash(value, name) {
  if (!HASH.test(value)) throw new TypeError(`${name} must be sha256:<64 lowercase hex>`);
  return value;
}

function assertReportDigest(report, name) {
  const signed = object(report, name);
  const expected = hash(signed.reportSha256, `${name}.reportSha256`);
  const unsigned = { ...signed };
  delete unsigned.reportSha256;
  if (tournamentTools.sha256Canonical(unsigned) !== expected) throw new Error(`${name} digest mismatch`);
  return signed;
}

function unique(items, name) {
  if (new Set(items).size !== items.length) throw new Error(`duplicate ${name}`);
}

/**
 * PLAN-ONLY bridge. A declared page review is NOT a verified guardian receipt;
 * this function cannot authorize or perform any publication or client mutation.
 * The expected digests MUST come from a trusted, independently retained decision.
 */
export function buildStrategyPageHandoff(rawReport, rawExpected, rawProposals) {
  const expected = object(rawExpected, "expected");
  const expectedSiteId = text(expected.siteId, "expected.siteId");
  const expectedScenarioSha256 = hash(expected.scenarioSha256, "expected.scenarioSha256");
  const expectedReportSha256 = hash(expected.reportSha256, "expected.reportSha256");
  const report = assertReportDigest(rawReport, "report");
  if (report.reportSha256 !== expectedReportSha256) throw new Error("untrusted tournament report digest");

  if (![2, 4].includes(report.schemaVersion)) throw new Error("unsupported tournament report schemaVersion");
  if (report.engineId !== `WALLE_NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V${report.schemaVersion}`) {
    throw new Error("unexpected tournament engineId");
  }
  const demand = report.schemaVersion === 4
    ? assertReportDigest(report.demandTournament, "report.demandTournament")
    : report;
  if (demand.schemaVersion !== 2 || demand.engineId !== "WALLE_NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V2") {
    throw new Error("missing validated V2 demand report");
  }
  if (demand.siteId !== expectedSiteId || demand.scenarioSha256 !== expectedScenarioSha256
    || report.scenarioSha256 !== expectedScenarioSha256) {
    throw new Error("site or scenario is not the trusted decision");
  }
  if (report.decisionBoundary !== NO_MUTATION || demand.decisionBoundary !== NO_MUTATION
    || demand.evidenceBoundary?.productionMutationAuthorized !== false) {
    throw new Error("tournament must not authorize production mutation");
  }
  const tournament = object(demand.tournament, "report.tournament");
  const selected = object(tournament.selectedStrategy, "report.tournament.selectedStrategy");
  if (selected.id !== tournament.selectedStrategyId || selected.eligible !== true
    || !Array.isArray(selected.disqualifiers) || selected.disqualifiers.length !== 0
    || !Array.isArray(selected.pageIds) || selected.pageIds.length === 0
    || selected.pageCount !== selected.pageIds.length) {
    throw new Error("selected strategy is invalid or disqualified");
  }
  if (report.schemaVersion === 4
    && (report.selectedStrategyId !== selected.id || report.growthFrontier?.winnerPageCount !== selected.pageCount)) {
    throw new Error("V4 winner does not match the underlying demand tournament");
  }
  unique(selected.pageIds, "selected page ID");
  const catalog = demand.architecture?.pages;
  if (!Array.isArray(catalog)) throw new TypeError("missing tournament page catalog");
  const byId = new Map();
  for (const page of catalog) {
    const id = text(page?.id, "catalog page ID");
    if (byId.has(id)) throw new Error(`duplicate catalog page: ${id}`);
    if (typeof page.title !== "string" || !Array.isArray(page.demandFamilyIds)
      || page.demandFamilyIds.length === 0) throw new Error(`invalid catalog page: ${id}`);
    byId.set(id, page);
  }
  for (const id of selected.pageIds) if (!byId.has(id)) throw new Error(`winner references missing page: ${id}`);

  if (!Array.isArray(rawProposals)) throw new TypeError("proposals must be an array");
  const blockers = [];
  const seen = new Set();
  const proposalById = new Map();
  const digests = new Map();
  const selectedIds = new Set(selected.pageIds);
  for (const proposal of rawProposals) {
    const row = object(proposal, "proposal");
    const id = text(row.pageId, "proposal.pageId");
    if (seen.has(id)) blockers.push(`DUPLICATE_PAGE_ID:${id}`);
    seen.add(id);
    if (!proposalById.has(id)) proposalById.set(id, row);
    if (!selectedIds.has(id)) blockers.push(`PAGE_NOT_SELECTED:${id}`);
    if (!ACTIONS.has(row.action)) blockers.push(`INVALID_ACTION:${id}`);
    if (!HASH.test(row.contentSha256)) blockers.push(`MISSING_CONTENT_DIGEST:${id}`);
    else {
      const first = digests.get(row.contentSha256);
      if (first && first !== id) blockers.push(`IDENTICAL_CONTENT:${first}:${id}`);
      digests.set(row.contentSha256, id);
    }
    const review = row.review;
    if (!review || ["editorial", "factualClaims", "policy"].some((field) => review[field] !== APPROVAL)) {
      blockers.push(`REVIEW_NOT_APPROVED:${id}`);
    }
  }
  for (const id of selected.pageIds) if (!seen.has(id)) blockers.push(`SELECTED_PAGE_MISSING:${id}`);

  const selectedPages = selected.pageIds.map((id) => ({
    pageId: id,
    title: byId.get(id).title,
    demandFamilyIds: [...byId.get(id).demandFamilyIds],
    // This is a declared digest, not verified bytes. The next proof binds it to real bytes.
    contentSha256: proposalById.get(id)?.contentSha256 ?? null,
  }));
  const result = {
    schemaVersion: 1,
    status: blockers.length ? "BLOCKED" : "REQUIRES_INDEPENDENT_GUARDIAN_EVIDENCE",
    siteId: expectedSiteId,
    scenarioSha256: expectedScenarioSha256,
    tournamentReportSha256: report.reportSha256,
    selectedStrategyId: selected.id,
    selectedPages,
    blockers,
    publicationAuthorized: false,
    clientMutationAuthorized: false,
    boundary: "DECLARED_REVIEWS_AND_CONTENT_DIGESTS_ARE_NOT_VERIFIED_RECEIPTS_OR_CONTENT_BYTES",
  };
  return Object.freeze({ ...result, handoffSha256: tournamentTools.sha256Canonical(result) });
}
