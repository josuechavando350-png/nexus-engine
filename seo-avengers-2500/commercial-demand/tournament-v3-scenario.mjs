const EXACT_SERVICE_SNAPSHOT = Object.freeze({
  id: "HYPD_EXACT_SERVICE_FRONTIER_2026_09_15",
  provider: "GOOGLE_ADS_KNOWN_KEYWORD_VOLUME_VIA_HYPD",
  capturedAt: "2026-09-15",
  resultId: "8df1cbfe-8a42-4389-af79-b8833785bc59",
  location: "Mexico",
  language: "Spanish",
});

export const ADDED_RELEVANT_FAMILY_IDS = Object.freeze([
  "AI_AGENTS_BUSINESS",
  "SYSTEM_INTEGRATION",
  "TECH_CONSULTING",
  "CUSTOMER_SERVICE_CHATBOT",
  "AI_VOICE_CALLS",
  "BI_SERVICES",
]);

export const ADDED_INFORMATIONAL_FAMILY_IDS = Object.freeze([
  "AI_AGENTS_GENERIC_INFO",
  "DASHBOARD_GENERIC_INFO",
]);

const NEW_FAMILIES = Object.freeze([
  {
    id: "AI_AGENTS_BUSINESS",
    cluster: "AI_AGENTS",
    intentClass: "MIXED",
    representativeKeyword: "agentes de ia para empresas",
    monthlySearchVolume: 20,
    competitionIndex: 60,
    sourceSnapshotId: EXACT_SERVICE_SNAPSHOT.id,
  },
  {
    id: "SYSTEM_INTEGRATION",
    cluster: "INTEGRATIONS",
    intentClass: "MIXED",
    representativeKeyword: "integracion de sistemas",
    monthlySearchVolume: 170,
    competitionIndex: 8,
    sourceSnapshotId: EXACT_SERVICE_SNAPSHOT.id,
  },
  {
    id: "TECH_CONSULTING",
    cluster: "CONSULTING",
    intentClass: "MIXED",
    representativeKeyword: "consultoria tecnologica",
    monthlySearchVolume: 110,
    competitionIndex: 22,
    sourceSnapshotId: EXACT_SERVICE_SNAPSHOT.id,
  },
  {
    id: "CUSTOMER_SERVICE_CHATBOT",
    cluster: "CUSTOMER_SERVICE",
    intentClass: "MIXED",
    representativeKeyword: "chatbot atención al cliente",
    monthlySearchVolume: 20,
    competitionIndex: 17,
    sourceSnapshotId: EXACT_SERVICE_SNAPSHOT.id,
  },
  {
    id: "AI_VOICE_CALLS",
    cluster: "VOICE_AI",
    intentClass: "MIXED",
    representativeKeyword: "llamadas con inteligencia artificial",
    monthlySearchVolume: 10,
    competitionIndex: 79,
    sourceSnapshotId: EXACT_SERVICE_SNAPSHOT.id,
  },
  {
    id: "BI_SERVICES",
    cluster: "DATA_ANALYTICS",
    intentClass: "DIRECT",
    representativeKeyword: "servicios de business intelligence",
    monthlySearchVolume: 10,
    competitionIndex: 48,
    sourceSnapshotId: EXACT_SERVICE_SNAPSHOT.id,
  },
  {
    id: "AI_AGENTS_GENERIC_INFO",
    cluster: "AI_AGENTS",
    intentClass: "INFORMATIONAL",
    representativeKeyword: "agentes de inteligencia artificial",
    monthlySearchVolume: 260,
    competitionIndex: 43,
    sourceSnapshotId: EXACT_SERVICE_SNAPSHOT.id,
  },
  {
    id: "DASHBOARD_GENERIC_INFO",
    cluster: "DATA_ANALYTICS",
    intentClass: "INFORMATIONAL",
    representativeKeyword: "dashboard empresarial",
    monthlySearchVolume: 70,
    competitionIndex: 29,
    sourceSnapshotId: EXACT_SERVICE_SNAPSHOT.id,
  },
]);

const NEW_SERVICE_PAGES = Object.freeze([
  { id: "ai-agents-business", title: "Agentes de IA para empresas", demandFamilyIds: ["AI_AGENTS_BUSINESS"] },
  { id: "systems-integration", title: "Integración de sistemas", demandFamilyIds: ["SYSTEM_INTEGRATION"] },
  { id: "technology-consulting", title: "Consultoría tecnológica", demandFamilyIds: ["TECH_CONSULTING"] },
  { id: "customer-service-chatbot", title: "Chatbot para atención al cliente", demandFamilyIds: ["CUSTOMER_SERVICE_CHATBOT"] },
  { id: "ai-voice-calls", title: "Llamadas con inteligencia artificial", demandFamilyIds: ["AI_VOICE_CALLS"] },
  { id: "business-intelligence-services", title: "Servicios de Business Intelligence", demandFamilyIds: ["BI_SERVICES"] },
]);

const BLOAT_CONTROL_PAGES = Object.freeze([
  { id: "ai-agents-vs-chatbot", title: "Agentes de IA vs chatbot", demandFamilyIds: ["AI_AGENTS_BUSINESS", "CUSTOMER_SERVICE_CHATBOT"] },
  { id: "integration-crm", title: "Integración de sistemas y CRM", demandFamilyIds: ["SYSTEM_INTEGRATION"] },
  { id: "technology-consulting-decision", title: "Cómo elegir consultoría tecnológica", demandFamilyIds: ["TECH_CONSULTING"] },
  { id: "customer-service-automation", title: "Automatización de atención al cliente", demandFamilyIds: ["CUSTOMER_SERVICE_CHATBOT"] },
  { id: "voice-ai-decision", title: "Agentes de voz con IA para empresas", demandFamilyIds: ["AI_VOICE_CALLS"] },
  { id: "analytics-decision", title: "Business Intelligence para empresas", demandFamilyIds: ["BI_SERVICES"] },
]);

const INFORMATIONAL_CONTROL_PAGES = Object.freeze([
  { id: "ai-agents-guide", title: "Qué son los agentes de inteligencia artificial", demandFamilyIds: ["AI_AGENTS_GENERIC_INFO"] },
  { id: "dashboard-guide", title: "Qué es un dashboard empresarial", demandFamilyIds: ["DASHBOARD_GENERIC_INFO"] },
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

export function buildCommercialDemandScenarioV3(rawBaseScenario) {
  const scenario = structuredClone(rawBaseScenario);
  if (scenario?.schemaVersion !== 2) throw new Error("V3 requires the validated V2 scenario schema");
  if (scenario?.scenarioId !== "NEXUS_COMMERCIAL_DEMAND_V2") throw new Error("V3 must be derived from the NEXUS V2 scenario");
  // The V3/V4 research, service evidence and page portfolio belong only to Nexus
  // Bot Studio. A changed label must not make the software tournament a CANO run.
  // This is identity-scope validation, NOT proof of Google provider ownership.
  if (scenario.siteId !== "nexus-bot-studio"
      || scenario.observedSearch?.account !== "sc-domain:nexusbotstudio.com") {
    throw new Error("NEXUS_COMMERCIAL_TOURNAMENT_CROSS_TENANT_BASELINE");
  }
  if (scenario.market?.country !== "Mexico" || scenario.market?.language !== "Spanish") {
    throw new Error("NEXUS_COMMERCIAL_TOURNAMENT_MARKET_MISMATCH");
  }

  const v2Winner = scenario.strategies.find((row) => row.id === "EVIDENCE_WEIGHTED_HYBRID_26");
  if (!v2Winner) throw new Error("V2 evidence-weighted 26-page baseline is missing");
  if (v2Winner.pageIds.length !== 26) throw new Error("V2 winner page count drifted from 26");

  scenario.scenarioId = "NEXUS_COMMERCIAL_DEMAND_V3";
  scenario.keywordResearch.snapshots.push(structuredClone(EXACT_SERVICE_SNAPSHOT));
  scenario.keywordResearch.rawCandidateRowCount += 8;
  scenario.keywordResearch.note = `${scenario.keywordResearch.note} V3 adds an exact eight-keyword service-frontier snapshot; generic AI-agent and dashboard terms are retained as informational controls rather than commercial capacity.`;

  assertUniqueIds(NEW_FAMILIES, "new family");
  appendRows(scenario.keywordResearch.families, NEW_FAMILIES, "demand family");
  scenario.keywordResearch.deduplicationExamples.push(
    {
      familyId: "AI_AGENTS_BUSINESS",
      absorbedVariantExamples: ["agentes ia empresas", "agentes de inteligencia artificial para empresas"],
    },
    {
      familyId: "SYSTEM_INTEGRATION",
      absorbedVariantExamples: ["integracion api", "integracion crm", "integracion de sistemas empresariales"],
    },
    {
      familyId: "TECH_CONSULTING",
      absorbedVariantExamples: ["consultora ti", "consultor ti", "consultores en ti"],
    },
    {
      familyId: "CUSTOMER_SERVICE_CHATBOT",
      absorbedVariantExamples: ["chatbot para atencion al cliente", "chatbot servicio al cliente", "bot de atencion al cliente"],
    },
  );

  const allNewPages = [...NEW_SERVICE_PAGES, ...BLOAT_CONTROL_PAGES, ...INFORMATIONAL_CONTROL_PAGES];
  assertUniqueIds(allNewPages, "new page");
  appendRows(scenario.pages, allNewPages, "page");

  const baseline = [...v2Winner.pageIds];
  const serviceIds = NEW_SERVICE_PAGES.map((row) => row.id);
  const coreServiceIds = serviceIds.slice(0, 3);
  const bloatIds = BLOAT_CONTROL_PAGES.map((row) => row.id);
  const informationalIds = INFORMATIONAL_CONTROL_PAGES.map((row) => row.id);

  scenario.strategies = [
    {
      id: "V2_EVIDENCE_WEIGHTED_HYBRID_BASELINE_26",
      pageIds: baseline,
      disqualifiers: [],
      architecture: "V2_26_PAGE_WINNER_PRESERVED_AS_CONTROL",
    },
    {
      id: "SERVICE_FRONTIER_CORE_29",
      pageIds: [...baseline, ...coreServiceIds],
      disqualifiers: [],
      architecture: "V2_WINNER_PLUS_AI_AGENTS_SYSTEM_INTEGRATION_AND_TECH_CONSULTING",
    },
    {
      id: "SERVICE_FRONTIER_FULL_VALIDATED_32",
      pageIds: [...baseline, ...serviceIds],
      disqualifiers: [],
      architecture: "V2_WINNER_PLUS_ALL_NEW_SERVICE_FAMILIES_WITH_SERP_INTENT_EVIDENCE",
    },
    {
      id: "SERVICE_FRONTIER_BLOAT_CONTROL_38",
      pageIds: [...baseline, ...serviceIds, ...bloatIds],
      disqualifiers: [],
      architecture: "FULL_VALIDATED_FRONTIER_PLUS_SIX_PAGES_WITHOUT_NEW_DEMAND_FAMILIES",
    },
    {
      id: "INFORMATIONAL_VOLUME_CONTROL_34",
      pageIds: [...baseline, ...serviceIds, ...informationalIds],
      disqualifiers: ["INFORMATIONAL_VOLUME_NOT_COMMERCIAL_CAPACITY"],
      architecture: "FULL_VALIDATED_FRONTIER_PLUS_GENERIC_AI_AGENT_AND_DASHBOARD_INFORMATIONAL_TERMS",
    },
  ];

  return scenario;
}

export const __test = Object.freeze({
  EXACT_SERVICE_SNAPSHOT,
  NEW_FAMILIES,
  NEW_SERVICE_PAGES,
  BLOAT_CONTROL_PAGES,
  INFORMATIONAL_CONTROL_PAGES,
});
