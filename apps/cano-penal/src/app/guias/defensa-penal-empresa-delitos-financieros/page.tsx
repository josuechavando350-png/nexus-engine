import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "../../SiteChrome";
import { site } from "../../content";

export const metadata: Metadata={
  title:"Defensa penal para empresas y delitos financieros CDMX",
  description:"Defensa penal empresarial, fraude y delitos financieros con una perspectiva especializada en investigaciones fiscales y financieras.",
  alternates:{canonical:"https://canopenal.com/guias/defensa-penal-empresa-delitos-financieros"},
};
const scopes=[
  ["Fraude y patrimonio","Analizar el origen del conflicto, los hechos denunciados y la documentación disponible."],
  ["Delitos financieros","Revisar el contexto de operaciones, información e investigaciones que involucren a la empresa."],
  ["Responsabilidad corporativa","Distinguir la situación de la organización de la de sus representantes y participantes."],
] as const;
export default function BusinessPage(){
  return <PageShell>
    <section className="cp-biz-hero"><div className="cp-wrap cp-biz-hero-grid"><div><span>EMPRESA / DEFENSA / ESTRATEGIA</span><h1>Lo que está en juego no termina en el expediente.</h1><p>Una investigación penal puede afectar decisiones, personas y continuidad operativa. El análisis debe ser preciso desde el primer contacto.</p></div><div className="cp-biz-axis" aria-hidden="true"><span>C</span><span>A</span><span>N</span><span>O</span></div></div></section>
    <section className="cp-biz-scope"><div className="cp-wrap"><p className="cp-eyebrow">Áreas relacionadas</p><h2>El mismo rigor.<br/><em>Distintos escenarios.</em></h2><div className="cp-biz-row-list">{scopes.map(([title,copy],i)=><article key={title}><span>0{i+1}</span><h3>{title}</h3><p>{copy}</p><span aria-hidden="true">↗</span></article>)}</div></div></section>
    <section className="cp-biz-proof"><div className="cp-wrap cp-biz-proof-grid"><div><span>EXPERIENCIA</span><h2>Conocer cómo se investiga cambia las preguntas.</h2></div><div><p>Eduardo Cano inició su trayectoria en el área de delitos fiscales y financieros de la Procuraduría Fiscal de la Federación y llegó a dirigir investigaciones de esa materia.</p><Link href="/acerca-de-mi">Conocer su trayectoria ↗</Link><Link href="/casos">Ver casos publicados ↗</Link><a href={site.whatsapp} rel="noopener noreferrer" target="_blank">Hablar con el despacho ↗</a></div></div></section>
  </PageShell>;
}
