import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "../../SiteChrome";
import { site } from "../../content";

export const metadata: Metadata = {
  title: "Requerimiento SAT y posible riesgo penal | CANO",
  description: "Qué revisar cuando recibes una comunicación del SAT y cuándo conviene una valoración penal-fiscal en Ciudad de México.",
  alternates: {canonical:"https://canopenal.com/guias/requerimiento-sat-riesgo-penal"},
};
const signals=[
  ["El documento","Identifica qué autoridad lo emite y qué te solicita."],
  ["El contexto","Una invitación, un requerimiento y una investigación no son situaciones idénticas."],
  ["La revisión","Conocer los antecedentes permite decidir qué asesoría necesitas."]
] as const;
export default function SatGuidePage(){
  return <PageShell>
    <section className="cp-sat-hero">
      <div className="cp-wrap cp-sat-hero-grid">
        <div className="cp-sat-headline"><p className="cp-eyebrow">Guía · Penal fiscal</p><h1>El SAT ya<br/>te escribió<span>.</span></h1><p>Antes de reaccionar, entiende qué documento recibiste y si existe un contexto que justifique una valoración penal-fiscal.</p><a className="cp-text-link" href={site.whatsapp} rel="noopener noreferrer" target="_blank">Consultar con CANO ↗</a></div>
        <div className="cp-sat-document" aria-label="Ilustración editorial de una comunicación por revisar"><div className="cp-sat-document-top"><span>DOCUMENTO / REFERENCIA</span><span>01 — 03</span></div><span className="cp-sat-document-rule"/><strong>Una comunicación no cuenta toda la historia.</strong><p>El tipo de aviso, el periodo y la autoridad cambian el análisis.</p><span className="cp-sat-document-end">CANO · ANÁLISIS PENAL FISCAL</span></div>
      </div>
    </section>
    <section className="cp-sat-questions"><div className="cp-wrap"><div className="cp-sat-questions-heading"><span>01 / LECTURA DEL CONTEXTO</span><h2>Qué conviene ubicar <em>primero.</em></h2></div><div className="cp-sat-question-list">{signals.map(([title,copy],i)=><article key={title}><span>0{i+1}</span><h3>{title}</h3><p>{copy}</p></article>)}</div></div></section>
    <section className="cp-sat-next"><div className="cp-wrap"><div><p className="cp-eyebrow">Experiencia desde dentro</p><h2>Una lectura fiscal.<br/><em>Una estrategia penal.</em></h2></div><div><p>Eduardo Cano dirigió investigaciones de delitos fiscales y financieros en la Procuraduría Fiscal de la Federación. Esa experiencia puede ser relevante cuando un asunto exige revisar su dimensión penal.</p><Link href="/areas/delitos-fiscales-y-financieros">Conocer el área penal-fiscal ↗</Link><Link href="/herramientas/calendario-fiscal">Consultar calendario fiscal ↗</Link></div></div></section>
  </PageShell>;
}
