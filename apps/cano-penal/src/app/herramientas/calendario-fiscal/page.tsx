import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "../../SiteChrome";
import { FiscalCalendar } from "../../FiscalCalendar";

export const metadata: Metadata = {
  title: "Calendario fiscal México 2026 | CANO Estrategia Penal",
  description: "Herramienta fiscal interactiva 2026 en preparación. Los vencimientos se mostrarán una vez individualmente verificados y aprobados.",
  alternates: { canonical: "https://canopenal.com/herramientas/calendario-fiscal" },
  robots: { index: false, follow: false },
};

export default function FiscalCalendarPage() {
  return (
    <PageShell>
      <header className="cp-cal-hero">
        <div className="cp-wrap cp-cal-hero-grid">
          <div>
            <p className="cp-eyebrow">CANO / Herramienta fiscal</p>
            <h1>El tiempo también forma parte de la <em>estrategia.</em></h1>
            <p>Una herramienta interactiva en preparación. Las fechas y obligaciones se mostrarán después de corroborar las fuentes oficiales y obtener la aprobación fiscal correspondiente.</p>
          </div>
          <div className="cp-cal-hero-aside"><span>2026</span><p>Información fiscal que merece precisión. Ninguna fecha sin verificar se publicará como vencimiento.</p></div>
        </div>
      </header>
      <div className="cp-wrap"><FiscalCalendar /></div>
      <section className="cp-cal-editorial">
        <div className="cp-wrap cp-cal-editorial-grid">
          <h2>Una fecha no cuenta toda la historia.</h2>
          <div><p>Los vencimientos pueden variar por régimen, RFC, días inhábiles y otras disposiciones. Mientras no existan datos aprobados, el calendario no muestra vencimientos. Consulta directamente al SAT y con tu asesor fiscal para determinar los plazos aplicables.</p><p>Si recibiste un requerimiento, una invitación o una comunicación de la autoridad fiscal, la revisión de sus posibles implicaciones penales requiere un análisis distinto al de una declaración ordinaria.</p><Link href="/guias/requerimiento-sat-riesgo-penal">Entender los requerimientos del SAT ↗</Link></div>
        </div>
      </section>
    </PageShell>
  );
}
