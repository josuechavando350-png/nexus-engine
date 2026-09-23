import { sha256Canonical } from "../../gauss/core/common.mjs";

const USABLE_STATUSES = new Set([
  "SUPPORTED_PUBLIC",
  "SUPPORTED_FIRST_PARTY_PUBLIC",
  "SUPPORTED_OFFICIAL",
  "SUPPORTED_OFFICIAL_NATIONAL",
  "SUPPORTED_OFFICIAL_GUIDANCE",
  "SUPPORTED_PUBLIC_REFERENCE_ONLY",
]);

const FAMILIES = Object.freeze([
  {
    id: "F1_PENAL_FISCAL_CAPTURE",
    name: "Captación penal-fiscal de alta intención",
    tags: ["penal-fiscal", "search", "high-intent", "diagnostic"],
    evidenceIds: ["E02", "E03", "E04", "E05", "E07", "E13", "E14"],
    variants: [
      { id: "S01", name: "Fortalecer hub existente de delitos fiscales", channel: "SEO", funnelStage: "BOFU",
        actions: ["Auditar la URL fiscal existente", "Reestructurar intención y FAQs", "Reforzar prueba de trayectoria fiscal", "Medir contactos atribuibles"], dependencies: ["E14"] },
      { id: "S02", name: "Cluster de intención defraudación fiscal", channel: "SEO", funnelStage: "BOFU",
        actions: ["Mapear consultas específicas", "Crear soporte no duplicado", "Enlazar al hub fiscal existente", "Instrumentar conversión"], dependencies: ["E03", "E14"] },
      { id: "S03", name: "Grupo Ads PENAL-FISCAL aislado", channel: "PAID_SEARCH", funnelStage: "BOFU",
        actions: ["Separar términos penal-fiscales", "Usar landing fiscal", "Aplicar negativas", "Medir consulta calificada y contrato"], dependencies: ["E13", "E14"] },
      { id: "S04", name: "Landing de riesgo penal-fiscal con diagnóstico", channel: "CRO", funnelStage: "BOFU",
        actions: ["Jerarquizar escenarios fiscales verificables", "Mostrar trayectoria fiscal", "Aclarar diagnóstico de 2,500 MXN", "Conectar a WhatsApp con contexto"], dependencies: ["E14"] },
    ],
  },
  {
    id: "F2_INTERACTIVE_FISCAL_PREVENTION",
    name: "Producto interactivo de prevención fiscal-penal",
    tags: ["penal-fiscal", "interactive-tool", "top-funnel", "retention"],
    evidenceIds: ["E04", "E05", "E09", "E10", "E14"],
    variants: [
      { id: "S05", name: "Calendario fiscal interactivo base", channel: "PRODUCT_CONTENT", funnelStage: "TOFU",
        actions: ["Filtrar obligaciones por perfil", "Mostrar fechas y fuentes oficiales", "Permitir guardar eventos", "Instrumentar uso anónimo"], dependencies: ["E10"] },
      { id: "S06", name: "Calendario por régimen con alertas opt-in", channel: "PRODUCT_CONTENT", funnelStage: "TOFU",
        actions: ["Segmentar por régimen", "Recordatorios voluntarios", "Fuentes SAT visibles", "Escalamiento a contenido preventivo"], dependencies: ["E10", "E14"] },
      { id: "S07", name: "Navegador de señales de riesgo fiscal-penal", channel: "INTERACTIVE_GUIDE", funnelStage: "MOFU",
        actions: ["Preguntas no diagnósticas", "Separar administrativo de penal", "Mostrar fuentes y límites", "CTA a diagnóstico cuando corresponda"], dependencies: ["E10", "E14"] },
      { id: "S08", name: "Modo contador para calendario preventivo", channel: "PRODUCT_CONTENT", funnelStage: "MOFU",
        actions: ["Vista orientada a contadores", "Checklist documental", "Fechas oficiales", "Canal de consulta profesional"], dependencies: ["E10", "E14"] },
    ],
  },
  {
    id: "F3_URGENT_CRIMINAL_INTENT",
    name: "Segmentación de intención penal urgente",
    tags: ["criminal", "urgent", "search", "whatsapp"],
    evidenceIds: ["E01", "E05", "E06", "E14"],
    variants: [
      { id: "S09", name: "Ruta específica para citatorio del Ministerio Público", channel: "SEO_PAID_SEARCH", funnelStage: "BOFU",
        actions: ["Página/intención citatorio", "Copy específico", "Checklist previo a comparecencia", "WhatsApp con contexto"], dependencies: ["E14"] },
      { id: "S10", name: "Ruta específica para detenido", channel: "SEO_PAID_SEARCH", funnelStage: "BOFU",
        actions: ["Intención detenido", "Información inmediata verificable", "Contacto de urgencia", "Medición de consulta calificada"], dependencies: ["E14"] },
      { id: "S11", name: "Ruta específica para audiencia inicial", channel: "SEO_PAID_SEARCH", funnelStage: "BOFU",
        actions: ["Intención audiencia inicial", "Explicar proceso y límites", "Prueba de experiencia acusatoria", "CTA diagnóstico/urgencia"], dependencies: ["E14"] },
      { id: "S12", name: "Triage de urgencia penal 24/7 sin promesas", channel: "CRO", funnelStage: "BOFU",
        actions: ["Clasificar motivo de contacto", "No prometer disponibilidad no comprobada", "Priorizar detenido/citatorio/audiencia", "Enviar contexto a WhatsApp"], dependencies: ["E14"] },
    ],
  },
  {
    id: "F4_AUTHORITY_PROOF",
    name: "Prueba de autoridad y experiencia institucional",
    tags: ["authority", "trust", "content", "conversion"],
    evidenceIds: ["E05", "E06", "E16"],
    variants: [
      { id: "S13", name: "Timeline verificable de trayectoria institucional", channel: "TRUST_CONTENT", funnelStage: "MOFU",
        actions: ["Ordenar cargos publicados", "Separar hechos de marketing", "Vincular experiencia a servicios pertinentes"], dependencies: [] },
      { id: "S14", name: "Mapa de cómo avanza una investigación penal", channel: "EDUCATIONAL_CONTENT", funnelStage: "MOFU",
        actions: ["Explicar etapas", "Distinguir autoridad y defensa", "Usar lenguaje no garantista", "Conectar cada etapa a contenido útil"], dependencies: [] },
      { id: "S15", name: "Metodología de diagnóstico CANO", channel: "CRO_TRUST", funnelStage: "MOFU",
        actions: ["Explicar qué incluye diagnóstico", "Aclarar que 2,500 MXN no cubren defensa completa", "Mostrar entregable del diagnóstico"], dependencies: [] },
      { id: "S16", name: "Biblioteca de patrones de caso verificables", channel: "TRUST_CONTENT", funnelStage: "MOFU",
        actions: ["Solo casos publicables y anonimizados", "Separar hechos de resultados", "Prohibir garantías", "Enlazar a áreas pertinentes"], dependencies: ["E14"] },
    ],
  },
  {
    id: "F5_ACCOUNTANT_BUSINESS_CHANNEL",
    name: "Canal contadores y dueños de negocio",
    tags: ["penal-fiscal", "partners", "top-funnel", "business"],
    evidenceIds: ["E02", "E05", "E07", "E09", "E10", "E14"],
    variants: [
      { id: "S17", name: "Toolkit preventivo para contadores", channel: "PARTNER_CONTENT", funnelStage: "TOFU",
        actions: ["Checklist de escalamiento", "Fuentes oficiales", "Diferenciar fiscal de penal", "Canal profesional de consulta"], dependencies: ["E10", "E14"] },
      { id: "S18", name: "Brief mensual fiscal-penal", channel: "NEWSLETTER", funnelStage: "TOFU",
        actions: ["Calendario del mes", "Cambios oficiales", "Riesgos explicados sin alarmismo", "CTA opt-in"], dependencies: ["E10"] },
      { id: "S19", name: "Landing de referencia profesional contador-abogado", channel: "PARTNERS", funnelStage: "MOFU",
        actions: ["Explicar cuándo escalar", "Canal de referencia", "Privacidad", "Seguimiento de origen"], dependencies: ["E14"] },
      { id: "S20", name: "Sesiones informativas para empresas y contadores", channel: "WEBINAR", funnelStage: "TOFU",
        actions: ["Tema específico", "Material verificable", "Registro opt-in", "Seguimiento medible"], dependencies: ["E10", "E14"] },
    ],
  },
  {
    id: "F6_LOCAL_CONVERSION_TRUST",
    name: "Conversión local y confianza",
    tags: ["local", "conversion", "whatsapp", "trust"],
    evidenceIds: ["E01", "E11", "E12", "E14", "E16"],
    variants: [
      { id: "S21", name: "Google Business Profile compliance-first", channel: "LOCAL", funnelStage: "BOFU",
        actions: ["Verificar elegibilidad física", "Corregir solo con evidencia", "No inventar ubicaciones", "Medir acciones locales"], dependencies: ["E12", "E14"] },
      { id: "S22", name: "Embudo de diagnóstico 2,500 MXN", channel: "CRO", funnelStage: "BOFU",
        actions: ["Aclarar alcance", "Recolectar motivo sin datos sensibles innecesarios", "Enviar a WhatsApp", "Medir diagnóstico y contrato por separado"], dependencies: ["E14"] },
      { id: "S23", name: "Enrutamiento WhatsApp por intención", channel: "CRO", funnelStage: "BOFU",
        actions: ["Citatorio/detenido/fiscal/otro", "Mensaje prellenado mínimo", "No recolectar expediente sensible en analítica", "Medir contacto calificado"], dependencies: ["E14"] },
      { id: "S24", name: "Cobertura geográfica sin doorway pages", channel: "LOCAL_SEO", funnelStage: "MOFU",
        actions: ["Describir cobertura real CDMX", "Evitar clones por alcaldía", "Usar prueba de servicio real", "Enlaces internos coherentes"], dependencies: ["E12", "E14"] },
    ],
  },
]);

function compareStrings(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export function validateAuditEvidence(audit) {
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) throw new TypeError("audit must be object");
  if (audit.schemaVersion !== 1 || audit.tournamentId !== "CANO_PENAL_CDMX_ZERO"
      || audit.siteId !== "cano-penal" || audit.siteHostname !== "canopenal.com") {
    throw new Error("CANO_AUDIT_IDENTITY_MISMATCH");
  }
  if (!Array.isArray(audit.signals) || audit.signals.length < 1) throw new Error("CANO_AUDIT_SIGNALS_REQUIRED");
  const map = new Map();
  for (const signal of audit.signals) {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) throw new Error("audit signal must be object");
    if (!/^E\d{2}$/.test(signal.id) || map.has(signal.id)) throw new Error(`invalid or duplicate audit signal:${signal.id}`);
    if (typeof signal.status !== "string" || typeof signal.claim !== "string" || !signal.claim.trim()) throw new Error(`invalid audit signal:${signal.id}`);
    map.set(signal.id, Object.freeze(structuredClone(signal)));
  }
  return Object.freeze({ audit: Object.freeze(structuredClone(audit)), signalById: map });
}

export function buildStrategyField(audit) {
  const { signalById } = validateAuditEvidence(audit);
  const strategies = [];
  for (const family of FAMILIES) {
    for (const variant of family.variants) {
      const evidenceIds = [...new Set(family.evidenceIds)].sort(compareStrings);
      for (const evidenceId of evidenceIds) if (!signalById.has(evidenceId)) throw new Error(`strategy references missing evidence:${variant.id}:${evidenceId}`);
      const usableEvidenceIds = evidenceIds.filter((id) => USABLE_STATUSES.has(signalById.get(id).status));
      const uncertainEvidenceIds = evidenceIds.filter((id) => !USABLE_STATUSES.has(signalById.get(id).status));
      strategies.push(Object.freeze({
        id: variant.id, familyId: family.id, familyName: family.name, name: variant.name,
        channel: variant.channel, funnelStage: variant.funnelStage, tags: Object.freeze([...family.tags]),
        actions: Object.freeze([...variant.actions]), evidenceIds: Object.freeze(evidenceIds),
        usableEvidenceIds: Object.freeze(usableEvidenceIds), uncertainEvidenceIds: Object.freeze(uncertainEvidenceIds),
        dependencies: Object.freeze([...variant.dependencies]),
        structuralMetrics: Object.freeze({
          usableEvidenceCount: usableEvidenceIds.length,
          uncertainEvidenceCount: uncertainEvidenceIds.length,
          actionCount: variant.actions.length,
          dependencyCount: variant.dependencies.length,
        }),
      }));
    }
  }
  if (strategies.length !== 24 || new Set(strategies.map((row) => row.id)).size !== 24) throw new Error("CANO_STRATEGY_FIELD_MUST_CONTAIN_EXACTLY_24");
  return Object.freeze(strategies);
}

export function structuralShortlist(strategies) {
  const grouped = new Map();
  for (const strategy of strategies) {
    if (!grouped.has(strategy.familyId)) grouped.set(strategy.familyId, []);
    grouped.get(strategy.familyId).push(strategy);
  }
  if (grouped.size !== 6) throw new Error("CANO_STRATEGY_FIELD_MUST_CONTAIN_SIX_FAMILIES");
  const shortlist = [];
  for (const [, rows] of [...grouped.entries()].sort(([a], [b]) => compareStrings(a, b))) {
    rows.sort((a, b) =>
      a.structuralMetrics.dependencyCount - b.structuralMetrics.dependencyCount
      || a.structuralMetrics.uncertainEvidenceCount - b.structuralMetrics.uncertainEvidenceCount
      || b.structuralMetrics.usableEvidenceCount - a.structuralMetrics.usableEvidenceCount
      || a.structuralMetrics.actionCount - b.structuralMetrics.actionCount
      || compareStrings(a.id, b.id));
    shortlist.push(...rows.slice(0, 2));
  }
  if (shortlist.length !== 12) throw new Error("CANO_STRUCTURAL_SHORTLIST_MUST_CONTAIN_EXACTLY_12");
  return Object.freeze(shortlist);
}

export function buildGaussRound0Problem(strategies, shortlist) {
  const paretoPoints = strategies.map((row) => ({
    id: row.id,
    values: [row.structuralMetrics.usableEvidenceCount, row.structuralMetrics.uncertainEvidenceCount, row.structuralMetrics.actionCount, row.structuralMetrics.dependencyCount],
  }));
  const fields = shortlist.map((row) => {
    const m = row.structuralMetrics;
    return -(2 * m.usableEvidenceCount - m.uncertainEvidenceCount - m.dependencyCount);
  });
  const couplings = [];
  for (let i = 0; i < shortlist.length; i += 1) {
    for (let j = i + 1; j < shortlist.length; j += 1) {
      const overlap = shortlist[i].tags.filter((tag) => shortlist[j].tags.includes(tag)).length;
      if (overlap > 0) couplings.push({ i, j, value: overlap / 4 });
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    problemId: "cano-penal-cdmx-round0-v1",
    objective: "Compare 24 audit-derived strategies by structural evidence metrics and run a bounded 12-candidate portfolio-diversity Ising experiment. No outcome forecast or commercial winner.",
    tasks: [
      { taskId: "cano-structural-pareto", layerId: "GAUSS.MATH.PARETO.002", input: { points: paretoPoints, objectives: ["MAX", "MIN", "MIN", "MIN"] } },
      { taskId: "cano-portfolio-diversity", layerId: "GAUSS.PHYSICS.ISING_EXACT_GROUND.003", input: { fields, couplings, offset: 0 } },
    ],
  });
}

export function strategyFieldDigest(strategies) { return sha256Canonical(strategies); }
