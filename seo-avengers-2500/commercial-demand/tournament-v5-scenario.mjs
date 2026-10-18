import { buildCommercialDemandScenarioV4 } from "./tournament-v4-scenario.mjs";

const DISCOVERY_SNAPSHOT_V5 = Object.freeze({
  id: "HYPD_OFFER_FIT_DISCOVERY_2026_09_16",
  provider: "GOOGLE_ADS_KEYWORD_RESEARCH_VIA_HYPD",
  capturedAt: "2026-09-16",
  resultId: "00d4509d-a716-4d3b-93be-8e4b51a4d9f7",
  location: "Mexico",
  language: "Spanish",
});

const EXACT_OFFER_FIT_SNAPSHOT_V5 = Object.freeze({
  id: "HYPD_EXACT_OFFER_FIT_FRONTIER_2026_09_16",
  provider: "GOOGLE_ADS_KNOWN_KEYWORD_VOLUME_VIA_HYPD",
  capturedAt: "2026-09-16",
  resultId: "46c867ce-8050-4ce6-a485-f13083945c78",
  location: "Mexico",
  language: "Spanish",
});

export const ADDED_RELEVANT_FAMILY_IDS_V5 = Object.freeze([
  "AI_CONSULTING_SPECIALIZED",
  "CUSTOM_ERP",
  "CUSTOM_CRM",
  "DATA_CONSULTING",
]);

export const OFFER_FIT_GUARD_EXPECTATIONS_V5 = Object.freeze([
  Object.freeze({
    guardId: "ECOMMERCE_DEVELOPMENT_OFFER_UNPROVEN",
    keyword: "desarrollo de ecommerce",
    monthlySearchVolume: 30,
    competitionIndex: 26,
    intentClass: "MIXED",
    offerFitClass: "FIRST_PARTY_OFFER_ALIGNMENT_UNPROVEN",
  }),
  Object.freeze({
    guardId: "SOFTWARE_MANAGEMENT_ADJACENT_PRODUCT",
    keyword: "software de gestion empresarial",
    monthlySearchVolume: 140,
    competitionIndex: 46,
    intentClass: "MIXED",
    offerFitClass: "ADJACENT_PRODUCT_MARKET_NOT_CUSTOM_DEVELOPMENT_DEMAND",
  }),
  Object.freeze({
    guardId: "POS_ADJACENT_PRODUCT",
    keyword: "puntos de venta para negocios",
    monthlySearchVolume: 2400,
    competitionIndex: 100,
    intentClass: "DECISION",
    offerFitClass: "ADJACENT_PRODUCT_MARKET_NOT_CUSTOM_DEVELOPMENT_DEMAND",
  }),
  Object.freeze({
    guardId: "ERP_SYSTEMS_GENERIC_INFORMATIONAL",
    keyword: "sistemas erp",
    monthlySearchVolume: 6600,
    competitionIndex: 41,
    intentClass: "INFORMATIONAL",
    offerFitClass: "INFORMATIONAL_GENERIC_MARKET_NOT_CUSTOM_DEVELOPMENT_DEMAND",
  }),
]);

export const OVERLAP_GUARD_EXPECTATIONS_V5 = Object.freeze([
  Object.freeze({
    guardId: "AI_COMPANY_EXISTING_FAMILY_SYNONYM",
    keyword: "empresa de inteligencia artificial",
    monthlySearchVolume: 170,
    competitionIndex: 36,
    existingFamilyId: "AI_COMPANY",
    overlapClass: "EXISTING_FAMILY_SEMANTIC_OVERLAP_NOT_ADDITIVE",
  }),
]);

const NEW_FAMILIES = Object.freeze([
  {
    id: "AI_CONSULTING_SPECIALIZED",
    cluster: "AI_CONSULTING",
    intentClass: "MIXED",
    representativeKeyword: "consultoria inteligencia artificial",
    monthlySearchVolume: 30,
    competitionIndex: 59,
    sourceSnapshotId: EXACT_OFFER_FIT_SNAPSHOT_V5.id,
  },
  {
    id: "CUSTOM_ERP",
    cluster: "CUSTOM_SOFTWARE",
    intentClass: "MIXED",
    representativeKeyword: "erp a medida",
    monthlySearchVolume: 10,
    competitionIndex: 71,
    sourceSnapshotId: EXACT_OFFER_FIT_SNAPSHOT_V5.id,
  },
  {
    id: "CUSTOM_CRM",
    cluster: "CUSTOM_SOFTWARE",
    intentClass: "MIXED",
    representativeKeyword: "crm a medida",
    monthlySearchVolume: 10,
    competitionIndex: 86,
    sourceSnapshotId: EXACT_OFFER_FIT_SNAPSHOT_V5.id,
  },
  {
    id: "DATA_CONSULTING",
    cluster: "DATA_ANALYTICS",
    intentClass: "MIXED",
    representativeKeyword: "consultoria de datos",
    monthlySearchVolume: 20,
    competitionIndex: 71,
    sourceSnapshotId: EXACT_OFFER_FIT_SNAPSHOT_V5.id,
  },
]);

const NEW_OFFER_FIT_PAGES = Object.freeze([
  {
    id: "ai-consulting-specialized",
    title: "Consultoría de inteligencia artificial",
    demandFamilyIds: ["AI_CONSULTING_SPECIALIZED"],
  },
  {
    id: "custom-erp",
    title: "ERP a medida",
    demandFamilyIds: ["CUSTOM_ERP"],
  },
  {
    id: "custom-crm",
    title: "CRM a medida",
    demandFamilyIds: ["CUSTOM_CRM"],
  },
  {
    id: "data-consulting",
    title: "Consultoría de datos",
    demandFamilyIds: ["DATA_CONSULTING"],
  },
]);

const BLOAT_CONTROL_PAGES = Object.freeze([
  {
    id: "ai-consulting-selection-v5",
    title: "Cómo elegir consultoría de inteligencia artificial",
    demandFamilyIds: ["AI_CONSULTING_SPECIALIZED"],
  },
  {
    id: "custom-erp-selection-v5",
    title: "Cómo elegir un ERP a medida",
    demandFamilyIds: ["CUSTOM_ERP"],
  },
  {
    id: "custom-crm-selection-v5",
    title: "Cómo elegir un CRM a medida",
    demandFamilyIds: ["CUSTOM_CRM"],
  },
  {
    id: "data-consulting-selection-v5",
    title: "Cómo elegir consultoría de datos",
    demandFamilyIds: ["DATA_CONSULTING"],
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

export function buildCommercialDemandScenarioV5(rawBaseScenario) {
  const scenario = buildCommercialDemandScenarioV4(rawBaseScenario);
  if (scenario?.schemaVersion !== 2) throw new Error("V5 requires the V4 scenario on the V2 deterministic schema");
  if (scenario?.scenarioId !== "NEXUS_COMMERCIAL_DEMAND_V4") throw new Error("V5 must be derived from the NEXUS V4 scenario");

  const v4Winner = scenario.strategies.find((row) => row.id === "SOFTWARE_BUYER_FRONTIER_FULL_VALIDATED_36");
  if (!v4Winner) throw new Error("V4 36-page winner is missing");
  if (v4Winner.pageIds.length !== 36) throw new Error("V4 winner page count drifted from 36");

  scenario.scenarioId = "NEXUS_COMMERCIAL_DEMAND_V5";
  scenario.keywordResearch.snapshots.push(structuredClone(DISCOVERY_SNAPSHOT_V5));
  scenario.keywordResearch.snapshots.push(structuredClone(EXACT_OFFER_FIT_SNAPSHOT_V5));
  scenario.keywordResearch.rawCandidateRowCount += 2656;
  scenario.keywordResearch.note = `${scenario.keywordResearch.note} V5 adds an offer-fit boundary: only distinct semantic families with SERP evidence and explicit first-party service alignment can add commercial capacity. Adjacent off-the-shelf product markets, unproven offer-fit terms, informational markets and existing-family synonyms are recorded as guards but never added to the demand scenario.`;

  assertUniqueIds(NEW_FAMILIES, "V5 family");
  appendRows(scenario.keywordResearch.families, NEW_FAMILIES, "demand family");
  scenario.keywordResearch.deduplicationExamples.push(
    {
      familyId: "AI_CONSULTING_SPECIALIZED",
      absorbedVariantExamples: ["consultoria de ia", "consultoría de inteligencia artificial"],
    },
    {
      familyId: "CUSTOM_ERP",
      absorbedVariantExamples: ["erp personalizado", "software erp a medida"],
    },
    {
      familyId: "CUSTOM_CRM",
      absorbedVariantExamples: ["crm personalizado", "desarrollo crm a medida"],
    },
    {
      familyId: "DATA_CONSULTING",
      absorbedVariantExamples: ["consultoría de datos", "consultoria data analytics"],
    },
  );

  const allNewPages = [...NEW_OFFER_FIT_PAGES, ...BLOAT_CONTROL_PAGES];
  assertUniqueIds(allNewPages, "V5 page");
  appendRows(scenario.pages, allNewPages, "page");

  const baseline = [...v4Winner.pageIds];
  const offerFitIds = NEW_OFFER_FIT_PAGES.map((row) => row.id);
  const coreIds = [offerFitIds[0], offerFitIds[3]];
  const bloatIds = BLOAT_CONTROL_PAGES.map((row) => row.id);

  scenario.strategies = [
    {
      id: "V4_SOFTWARE_BUYER_BASELINE_36",
      pageIds: baseline,
      disqualifiers: [],
      architecture: "CERTIFIED_V4_36_PAGE_WINNER_PRESERVED_AS_CONTROL",
    },
    {
      id: "OFFER_FIT_CORE_38",
      pageIds: [...baseline, ...coreIds],
      disqualifiers: [],
      architecture: "V4_WINNER_PLUS_AI_AND_DATA_CONSULTING_FAMILIES_WITH_FIRST_PARTY_OFFER_FIT",
    },
    {
      id: "OFFER_FIT_FULL_VALIDATED_40",
      pageIds: [...baseline, ...offerFitIds],
      disqualifiers: [],
      architecture: "V4_WINNER_PLUS_ALL_FOUR_V5_FIRST_PARTY_ALIGNED_DISTINCT_FAMILIES",
    },
    {
      id: "OFFER_FIT_BLOAT_CONTROL_44",
      pageIds: [...baseline, ...offerFitIds, ...bloatIds],
      disqualifiers: [],
      architecture: "FULL_V5_OFFER_FIT_FRONTIER_PLUS_FOUR_PAGES_WITHOUT_NEW_DEMAND_FAMILIES",
    },
  ];

  return scenario;
}

export const __test = Object.freeze({
  DISCOVERY_SNAPSHOT_V5,
  EXACT_OFFER_FIT_SNAPSHOT_V5,
  NEW_FAMILIES,
  NEW_OFFER_FIT_PAGES,
  BLOAT_CONTROL_PAGES,
});
