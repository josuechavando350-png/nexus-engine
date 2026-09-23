/** SAT-source-driven reference calendar; no individualized deadlines or inferred extensions. */
export const SAT_SOURCES = {
  fisica: {
    title: "SAT · Pagos mensuales de personas físicas",
    url: "https://wwwmat.sat.gob.mx/declaracion/33006/presenta-tu-declaracion-de-actividades-empresariales-y-servicios-profesionales,-arrendamiento-e-iva,-personas-fisicas-de-2025-en-adelante-(simulador)",
  },
  moral: {
    title: "SAT · Pagos provisionales o definitivos de personas morales",
    url: "https://wwwmat.sat.gob.mx/declaracion/95291/declaracion-mensual-para-tu-empresa-en-el-servicio-de-declaraciones-y-pagos",
  },
  relevante: {
    title: "SAT · Declaración informativa de operaciones relevantes",
    url: "https://wwwmatnp.sat.gob.mx/declaracion/11315/declaracion-informativa-de-operaciones-relevantes",
  },
} as const;

export type FiscalAudience = "fisica" | "moral";
export type FiscalCalendarEvent = Readonly<{
  id: string;
  year: 2026;
  month: number;
  day: number;
  audience: FiscalAudience;
  title: string;
  period: string;
  sourceUrl: string;
  sourceTitle: string;
  verifiedOn: "2026-09-23";
  type: "GENERAL_REFERENCE" | "OFFICIAL_SPECIFIC";
  note: string;
}>;

export const MONTHS = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"] as const;

const monthlyEvents: FiscalCalendarEvent[] = Array.from({length:12}, (_, month) =>
  (["fisica", "moral"] as const).map((audience): FiscalCalendarEvent => ({
    id: `monthly-${audience}-${month + 1}`,
    year: 2026,
    month,
    day: 17,
    audience,
    title: audience === "fisica" ? "Pagos mensuales · persona física" : "Pagos provisionales o definitivos · empresa",
    period: MONTHS[(month + 11) % 12] + (month === 0 ? " 2025" : " 2026"),
    sourceUrl: SAT_SOURCES[audience].url,
    sourceTitle: SAT_SOURCES[audience].title,
    verifiedOn: "2026-09-23",
    type: "GENERAL_REFERENCE",
    note: "Día general de referencia. La fecha aplicable puede variar por RFC, días inhábiles, régimen y disposiciones vigentes. Confirma el plazo en el SAT antes de presentar.",
  }))
).flat();

export const FISCAL_EVENTS: readonly FiscalCalendarEvent[] = Object.freeze([
  ...monthlyEvents,
  {
    id: "relevant-operations-q3",
    year: 2026,
    month: 10,
    day: 30,
    audience: "moral",
    title: "Operaciones relevantes · julio a septiembre",
    period: "Tercer trimestre de 2026",
    sourceUrl: SAT_SOURCES.relevante.url,
    sourceTitle: SAT_SOURCES.relevante.title,
    verifiedOn: "2026-09-23",
    type: "OFFICIAL_SPECIFIC",
    note: "Sólo para contribuyentes sujetos a esta declaración. Confirma aplicabilidad, calendario vigente y días inhábiles con tu asesor fiscal o el SAT.",
  },
]);
