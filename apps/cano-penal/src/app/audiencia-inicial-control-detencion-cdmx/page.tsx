import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "../SiteChrome";
import { site } from "../content";

export const metadata: Metadata={
  title:"Abogado para audiencia inicial y control de detención CDMX",
  description:"Defensa penal y orientación para audiencia inicial o control de detención en Ciudad de México con Eduardo Cano.",
  alternates:{canonical:"https://canopenal.com/audiencia-inicial-control-detencion-cdmx"},
};
const focus=[
  ["Contexto","Entender de qué hechos y etapa se trata."],
  ["Información","Ubicar qué documentos y antecedentes existen."],
  ["Defensa","Preparar la conversación sobre representación y estrategia."],
] as const;
export default function AudienciaPage(){
  return <PageShell>
    <section className="cp-aud-hero"><img src="/media/audiencia-03.jpg" alt="" aria-hidden="true"/><div className="cp-aud-hero-overlay"/><div className="cp-wrap cp-aud-hero-content"><p className="cp-eyebrow">Proceso penal · CDMX</p><h1>Una audiencia se prepara <em>mucho antes de comenzar.</em></h1><p>La primera conversación de defensa debe considerar la situación, la información disponible y el momento del procedimiento.</p><a href={site.phoneHref} className="cp-btn cp-btn-solid">Hablar con CANO →</a></div><div className="cp-aud-photo-caption">DEFENSA PENAL / AUDIENCIA INICIAL</div></section>
    <section className="cp-aud-editorial"><div className="cp-wrap"><div className="cp-aud-intro"><span>EJES DE PREPARACIÓN</span><h2>Un análisis con<br/>dirección.</h2></div><div className="cp-aud-focus">{focus.map(([title,copy])=><article key={title}><h3>{title}</h3><p>{copy}</p></article>)}</div></div></section>
    <section className="cp-aud-follow"><div className="cp-wrap"><div><p className="cp-eyebrow">Continuidad de la defensa</p><h2>La estrategia no empieza en sala.</h2></div><div><p>Si existe una detención o un familiar está bajo custodia, revisa también la ruta de orientación urgente.</p><Link href="/detenido-cdmx">Atención para detenido ↗</Link><a href={site.whatsapp} rel="noopener noreferrer" target="_blank">Consultar al despacho ↗</a></div></div></section>
  </PageShell>;
}
