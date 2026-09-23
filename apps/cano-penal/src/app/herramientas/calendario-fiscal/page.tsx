import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "../../SiteChrome";
import { FiscalCalendar } from "../../FiscalCalendar";

export const metadata: Metadata = {
  title: "Calendario fiscal México 2026 | Referencias oficiales SAT",
  description: "Calendario fiscal interactivo de referencia para personas físicas y morales en México, con fuentes oficiales del SAT y contexto de defensa penal-fiscal.",
  alternates: { canonical: "https://canopenal.com/herramientas/calendario-fiscal" },
};

export default function FiscalCalendarPage() {
  return (
    <PageShell>
      <header className="cp-cal-hero">
        <div className="cp-wrap cp-cal-hero-grid">
          <div>
            <p className="cp-eyebrow">CANO / Herramienta fiscal</p>
            <h1>El tiempo también forma parte de la <em>estrategia.</em></h1>
            <p>Un calendario interactivo para consultar referencias generales de obligaciones fiscales, revisar sus fuentes oficiales y ubicar el contexto de cada periodo.</p>
          </div>
          <div className="cp-cal-hero-aside"><span>2026</span><p>Información fiscal que merece precisión. Sin fechas inventadas y sin sustituir la consulta al SAT.</p></div>
        </div>
      </header>
      <div className="cp-wrap"><FiscalCalendar /></div>
      <section className="cp-cal-editorial">
        <div className="cp-wrap cp-cal-editorial-grid">
          <h2>Una fecha no cuenta toda la historia.</h2>
          <div><p>Los vencimientos pueden variar por régimen, RFC, días inhábiles y otras disposiciones. El calendario muestra fechas generales de referencia y distingue obligaciones específicas que requieren confirmar su aplicabilidad.</p><p>Si recibiste un requerimiento, una invitación o una comunicación de la autoridad fiscal, la revisión de sus posibles implicaciones penales requiere un análisis distinto al de una declaración ordinaria.</p><Link href="/guias/requerimiento-sat-riesgo-penal">Entender los requerimientos del SAT ↗</Link></div>
        </div>
      </section>
    </PageShell>
  );
}
