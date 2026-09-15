import { buildCommercialDemandScenarioV3 } from "./tournament-v3-scenario.mjs";

const DISCOVERY_SNAPSHOT = Object.freeze({
  id: "HYPD_SOFTWARE_BUYER_DISCOVERY_2026_09_15",
  provider: "GOOGLE_ADS_KEYWORD_RESEARCH_VIA_HYPD",
  capturedAt: "2026-09-15",
  resultId: "49208b09-f11e-4031-8fca-03b1ed756d85",
  location: "Mexico",
  language: "Spanish",
});

const EXACT_SOFTWARE_SNAPSHOT = Object.freeze({
  id: "HYPD_EXACT_SOFTWARE_BUYER_FRONTIER_2026_09_15",
  provider: "GOOGLE_ADS_KNOWN_KEYWORD_VOLUME_VIA_HYPD",
  capturedAt: "2026-09-15",
  resultId: "ea1854ca-8880-4bf7-ba54-29708bcc0928",
  location: "Mexico",
  language: "Spanish",
});

export const ADDED_RELEVANT_FAMILY_IDS_V4 = Object.freeze([
  "SOFTWARE_COMPANY_GENERIC",
  "SOFTWARE_DEVELOPMENT_COMPANY",
  "SOFTWARE_CONSULTING",
  "SOFTWARE_FACTORY",
]);

export const ADDED_INFORMATIONAL_FAMILY_IDS_V4 = Object.freeze([
  "SOFTWARE_DEVELOPMENT_GENERIC_INFO",
]);

const NEW_FAMILIES = Object.freeze([
  {
    id: "SOFTWARE_COMPANY_GENERIC",
    cluster: "SOFTWARE",
    intentClass: "MIXED",
    representativeKeyword: "empresa de software",
    monthlySearchVolume: 1000,
    competitionIndex: 18,
    sourceSnapshotId: EXACT_SOFTWARE_SNAPSHOT.id,
  },
  {
    id: "SOFTWARE_DEVELOPMENT_COMPANY",
    cluster: "SOFTWARE",
    intentClass: "DECISION",
    representativeKeyword: "empresas de desarrollo de software",
    monthlySearchVolume: 480,
    competitionIndex: 49,
    sourceSnapshotId: EXACT_SOFTWARE_SNAPSHOT.id,
  },
  {
    id: "SOFTWARE_CONSULTING",
    cluster: "SOFTWARE",
    intentClass: "MIXED",
    representativeKeyword: "consultoria de software",
    monthlySearchVolume: 170,
    competitionIndex: 53,
    sourceSnapshotId: EXACT_SOFTWARE_SNAPSHOT.id,
  },
  {
    id: "SOFTWARE_FACTORY",
    cluster: "SOFTWARE",
    intentClass: "MIXED",
    representativeKeyword: "fabrica de software",
    monthlySearchVolume: 140,
    competitionIndex: 41,
    sourceSnapshotId: EXACT_SOFTWARE_SNAPSHOT.id,
  },
  {
    id: "SOFTWARE_DEVELOPMENT_GENERIC_INFO",
    cluster: "SOFTWARE",
    intentClass: "INFORMATIONAL",
    representativeKeyword: "desarrollo de software",
    monthlySearchVolume: 5400,
    competitionIndex: 36,
    sourceSnapshotId: EXACT_SOFTWARE_SNAPSHOT.id,
  },
]);

const NEW_BUYER_PAGES = Object.freeze([
  {
    id: "software-company",
    title: "Empresa de software",
    demandFamilyIds: ["SOFTWARE_COMPANY_GENERIC"],
  },
  {
    id: "software-development-companies",
    title: "Empresas de desarrollo de software",
    demandFamilyIds: ["SOFTWARE_DEVELOPMENT_COMPANY"],
  },
  {
    id: "software-consulting",
    title: "Consultoría de software",
    demandFamilyIds: ["SOFTWARE_CONSULTING"],
  },
  {
    id: "software-factory",
    title: "Fábrica de software",
    demandFamilyIds: ["SOFTWARE_FACTORY"],
  },
]);

const BLOAT_CONTROL_PAGES = Object.freeze([
  {
    id: "software-company-selection",
    title: "Cómo elegir una empresa de software",
    demandFamilyIds: ["SOFTWARE_COMPANY_GENERIC", "SOFTWARE_DEVELOPMENT_COMPANY"],
  },
  {
    id: "software-consulting-selection",
    title: "Cómo elegir consultoría de software",
    demandFamilyIds: ["SOFTWARE_CONSULTING"],
  },
  {
    id: "software-factory-selection",
    title: "Cómo elegir una fábrica de software",
    demandFamilyIds: ["SOFTWARE_FACTORY"],
  },
  {
    id: "software-partner-decision",
    title: "Socio de desarrollo de software para empresas",
    demandFamilyIds: ["SOFTWARE_COMPANY_GENERIC", "SOFTWARE_DEVELOPMENT_COMPANY"],
  },
]);

const INFORMATIONAL_CONTROL_PAGES = Object.freeze([
  {
    id: "software-development-guide",
    title: "Qué es el desarrollo de software",
    demandFamilyIds: ["SOFTWARE_DEVELOPMENT_GENERIC_INFO"],
  },
]);

function assertUniqueIds(rows, name) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`duplicate ${name} id: ${row.id}`);
    seen.add(row.id);
  }
}

function appendRows(target, rows, name) {
  const existing = new Set(target.map((row) => row.id));
  for (const row of rows) {
    if (existing.has(row.id)) throw new Error(`${name} already exists: ${row.id}`);
    target.push(structuredClone(row));
    existing.add(row.id);
  }
}

export function buildCommercialDemandScenarioV4(rawBaseScenario) {
  const scenario = buildCommercialDemandScenarioV3(rawBaseScenario);
  if (scenario?.schemaVersion !== 2) throw new Error("V4 requires the V3 scenario on the V2 deterministic schema");
  if (scenario?.scenarioId !== "NEXUS_COMMERCIAL_DEMAND_V3") throw new Error("V4 must be derived from the NEXUS V3 scenario");

  const v3Winner = scenario.strategies.find((row) => row.id === "SERVICE_FRONTIER_FULL_VALIDATED_32");
  if (!v3Winner) throw new Error("V3 32-page service-frontier winner is missing");
  if (v3Winner.pageIds.length !== 32) throw new Error("V3 winner page count drifted from 32");

  scenario.scenarioId = "NEXUS_COMMERCIAL_DEMAND_V4";
  scenario.keywordResearch.snapshots.push(structuredClone(DISCOVERY_SNAPSHOT));
  scenario.keywordResearch.snapshots.push(structuredClone(EXACT_SOFTWARE_SNAPSHOT));
  scenario.keywordResearch.rawCandidateRowCount += 723;
  scenario.keywordResearch.note = `${scenario.keywordResearch.note} V4 reviewed a 723-row software/automation/chatbot discovery set, then bound five exact software keywords to a separate known-keyword snapshot. Discovery rows are not added as market size; only conservative semantic families with explicit SERP intent evidence can add relevant capacity.`;

  assertUniqueIds(NEW_FAMILIES, "new family");
  appendRows(scenario.keywordResearch.families, NEW_FAMILIES, "demand family");
  scenario.keywordResearch.deduplicationExamples.push(
    {
      familyId: "SOFTWARE_COMPANY_GENERIC",
      absorbedVariantExamples: ["empresas de software"],
    },
    {
      familyId: "SOFTWARE_DEVELOPMENT_COMPANY",
      absorbedVariantExamples: ["empresa de desarrollo de software", "empresa de desarrollo software"],
    },
    {
      familyId: "SOFTWARE_CONSULTING",
      absorbedVariantExamples: ["consultoría de software", "consultoras de software"],
    },
    {
      familyId: "SOFTWARE_FACTORY",
      absorbedVariantExamples: ["fábrica de software"],
    },
  );

  const allNewPages = [...NEW_BUYER_PAGES, ...BLOAT_CONTROL_PAGES, ...INFORMATIONAL_CONTROL_PAGES];
  assertUniqueIds(allNewPages, "new page");
  appendRows(scenario.pages, allNewPages, "page");

  const baseline = [...v3Winner.pageIds];
  const buyerIds = NEW_BUYER_PAGES.map((row) => row.id);
  const coreBuyerIds = buyerIds.slice(0, 2);
  const bloatIds = BLOAT_CONTROL_PAGES.map((row) => row.id);
  const informationalIds = INFORMATIONAL_CONTROL_PAGES.map((row) => row.id);

  scenario.strategies = [
    {
      id: "V3_SERVICE_FRONTIER_BASELINE_32",
      pageIds: baseline,
      disqualifiers: [],
      architecture: "V3_32_PAGE_WINNER_PRESERVED_AS_CONTROL",
    },
    {
      id: "SOFTWARE_BUYER_FRONTIER_CORE_34",
      pageIds: [...baseline, ...coreBuyerIds],
      disqualifiers: [],
      architecture: "V3_WINNER_PLUS_SOFTWARE_COMPANY_AND_DEVELOPMENT_COMPANY_BUYER_FAMILIES",
    },
    {
      id: "SOFTWARE_BUYER_FRONTIER_FULL_VALIDATED_36",
      pageIds: [...baseline, ...buyerIds],
      disqualifiers: [],
      architecture: "V3_WINNER_PLUS_ALL_FOUR_NEW_SOFTWARE_BUYER_FAMILIES_WITH_SERP_INTENT_EVIDENCE",
    },
    {
      id: "SOFTWARE_BUYER_BLOAT_CONTROL_40",
      pageIds: [...baseline, ...buyerIds, ...bloatIds],
      disqualifiers: [],
      architecture: "FULL_VALIDATED_SOFTWARE_FRONTIER_PLUS_FOUR_PAGES_WITHOUT_NEW_DEMAND_FAMILIES",
    },
    {
      id: "SOFTWARE_GENERIC_INFO_CONTROL_37",
      pageIds: [...baseline, ...buyerIds, ...informationalIds],
      disqualifiers: ["INFORMATIONAL_VOLUME_NOT_COMMERCIAL_CAPACITY"],
      architecture: "FULL_VALIDATED_SOFTWARE_FRONTIER_PLUS_GENERIC_DEVELOPMENT_INFORMATIONAL_TERM",
    },
  ];

  return scenario;
}

export const __test = Object.freeze({
  DISCOVERY_SNAPSHOT,
  EXACT_SOFTWARE_SNAPSHOT,
  NEW_FAMILIES,
  NEW_BUYER_PAGES,
  BLOAT_CONTROL_PAGES,
  INFORMATIONAL_CONTROL_PAGES,
});
