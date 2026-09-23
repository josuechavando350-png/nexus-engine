import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "../../SiteChrome";
import { site } from "../../content";

export const metadata: Metadata={
  title:"Responsabilidad penal fiscal de representantes y contadores",
  description:"Orientación penal-fiscal para representantes legales y contadores ante investigaciones o comunicaciones de la autoridad en México.",
  alternates:{canonical:"https://canopenal.com/guias/responsabilidad-penal-representante-legal-contador"},
};
export default function ProfessionalsPage(){
  return <PageShell>
    <section className="cp-pro-hero"><div className="cp-wrap cp-pro-hero-grid"><div><p className="cp-eyebrow">Penal fiscal · Profesionales</p><h1>Una firma.<br/>Una decisión.<br/><em>Un contexto.</em></h1></div><div><span>01 — 02 / PERFIL</span><p>Cuando una empresa enfrenta preguntas de la autoridad, el rol de cada persona importa. No conviene tratar todas las responsabilidades como si fueran iguales.</p><Link href="/areas/delitos-fiscales-y-financieros">Ir al área fiscal ↗</Link></div></div></section>
    <section className="cp-pro-split"><div className="cp-pro-panel cp-pro-panel-a"><span>01 / REPRESENTANTES</span><h2>Representante<br/><em>legal.</em></h2><p>La representación de una empresa puede exigir revisar decisiones, facultades, documentación y actuaciones concretas. La situación penal debe evaluarse conforme a los hechos y no sólo al cargo.</p><a href={site.whatsapp} rel="noopener noreferrer" target="_blank">Revisar mi situación ↗</a></div><div className="cp-pro-panel cp-pro-panel-b"><span>02 / CONTABILIDAD</span><h2>Contador<br/><em>o asesor.</em></h2><p>El alcance de una asesoría, las operaciones documentadas y el contexto de una investigación requieren un análisis específico. No debe presumirse responsabilidad por una función profesional.</p><a href={site.whatsapp} rel="noopener noreferrer" target="_blank">Consultar con CANO ↗</a></div></section>
    <section className="cp-pro-bridge"><div className="cp-wrap"><span>EL PUNTO DE CONEXIÓN</span><h2>Del expediente fiscal a la pregunta penal.</h2><div><p>Eduardo Cano trabajó en investigaciones de delitos fiscales y financieros en la Procuraduría Fiscal de la Federación. La perspectiva del despacho es analizar el asunto desde su contexto real.</p><Link href="/guias/requerimiento-sat-riesgo-penal">¿Recibiste un requerimiento del SAT? ↗</Link></div></div></section>
  </PageShell>;
}
