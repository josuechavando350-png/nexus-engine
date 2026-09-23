/** Publish only individually verified obligations after fiscal/legal approval by the despacho. */
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
  verifiedOn: string;
  sourceEvidence: string;
  approvedBy: string;
  type: "GENERAL_REFERENCE" | "OFFICIAL_SPECIFIC";
  note: string;
}>;

export const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"] as const;

// Empty by design: do not generate a monthly deadline formula or publish unverifiable dates.
// Populate only after confirming official URL, applicable tax regime, deadline, exceptions and fiscal/legal approval.
export const FISCAL_EVENTS: readonly FiscalCalendarEvent[] = Object.freeze([]);
