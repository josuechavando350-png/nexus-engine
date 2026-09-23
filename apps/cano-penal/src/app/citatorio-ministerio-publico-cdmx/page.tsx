import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "../SiteChrome";
import { site } from "../content";

export const metadata: Metadata={
  title:"Citatorio del Ministerio Público CDMX | Abogado penalista",
  description:"Atención penal ante un citatorio de la Fiscalía o el Ministerio Público en CDMX. Revisa el contexto con CANO Estrategia Penal.",
  alternates:{canonical:"https://canopenal.com/citatorio-ministerio-publico-cdmx"},
};
const fields=[
  ["01","Autoridad","Quién emite la comunicación y cómo aparece identificada."],
  ["02","Comparecencia","Qué fecha, lugar y finalidad señala el documento."],
  ["03","Situación","Qué información necesitas aclarar con tu abogado antes de actuar."],
] as const;
export default function CitatorioPage(){
  return <PageShell>
    <section className="cp-cit-hero"><div className="cp-wrap cp-cit-hero-layout"><div className="cp-cit-title"><span>Fiscalía / Ministerio Público</span><h1>Recibiste un<br/><em>citatorio.</em></h1><p>El siguiente paso debe empezar por entender la comunicación y tu situación concreta. Una asesoría temprana ayuda a ubicar el problema.</p></div><div className="cp-cit-hero-line"><span>CIUDAD DE MÉXICO</span><a href={site.phoneHref}>Hablar con el despacho <b>↗</b></a></div></div></section>
    <section className="cp-cit-content"><div className="cp-wrap cp-cit-content-grid"><div><span className="cp-cit-side-label">LECTURA INICIAL</span><h2>No todos los<br/>citatorios son<br/><em>iguales.</em></h2><p>Antes de compartir información, conviene ubicar el tipo de comunicación y el momento del procedimiento.</p><Link href="/audiencia-inicial-control-detencion-cdmx">¿Hay audiencia próxima? ↗</Link></div><div className="cp-cit-fields">{fields.map(([n,title,copy])=><article key={n}><span>{n}</span><div><h3>{title}</h3><p>{copy}</p></div></article>)}</div></div></section>
    <section className="cp-cit-contact"><div className="cp-wrap"><span>CONTACTO DIRECTO / CANO</span><h2>La conversación correcta empieza antes de la comparecencia.</h2><div><a className="cp-btn cp-btn-solid" href={site.whatsapp} rel="noopener noreferrer" target="_blank">Escribir por WhatsApp ↗</a><a className="cp-btn" href={site.phoneHref}>Llamar {site.phoneDisplay}</a></div></div></section>
  </PageShell>;
}
