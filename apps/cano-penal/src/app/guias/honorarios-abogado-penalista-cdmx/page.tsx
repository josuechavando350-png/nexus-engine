import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "../../SiteChrome";
import { site } from "../../content";

export const metadata: Metadata={
  title:"Honorarios de abogado penalista CDMX | Diagnóstico CANO",
  description:"Cómo entender el costo de una consulta penal y los honorarios de una defensa. Diagnóstico presencial de CANO: $2,500 MXN.",
  alternates:{canonical:"https://canopenal.com/guias/honorarios-abogado-penalista-cdmx"},
};
export default function HonorariosPage(){
  return <PageShell>
    <section className="cp-fee-hero"><div className="cp-wrap cp-fee-hero-layout"><p className="cp-eyebrow">Honorarios · Transparencia</p><h1>¿Cuánto cuesta<br/>una defensa <em>bien estudiada?</em></h1><p>Los honorarios de una defensa penal dependen del asunto y del trabajo que exige. La consulta inicial y una representación integral son servicios diferentes.</p><span className="cp-fee-giant" aria-hidden="true">$</span></div></section>
    <section className="cp-fee-price"><div className="cp-wrap cp-fee-price-layout"><div><span>01 / DIAGNÓSTICO PUBLICADO</span><h2>Un punto de partida claro.</h2></div><div className="cp-fee-price-amount"><span>Consulta presencial / diagnóstico y estrategia</span><strong>$2,500 <small>MXN</small></strong><p>Valoración y estudio inicial de tu situación penal, según la modalidad anunciada por el despacho. No es el precio de una defensa completa.</p><Link href="/diagnostico-penal">Conocer el diagnóstico ↗</Link></div></div></section>
    <section className="cp-fee-factors"><div className="cp-wrap"><p className="cp-eyebrow">02 / DEFENSA INTEGRAL</p><h2>El alcance se define<br/>con el caso.</h2><div className="cp-fee-factor-grid"><div><b>01</b><h3>Etapa</h3><p>La necesidad de atención cambia según el momento procesal.</p></div><div><b>02</b><h3>Complejidad</h3><p>El volumen de información, las diligencias y el análisis requerido varían entre asuntos.</p></div><div><b>03</b><h3>Representación</h3><p>La propuesta de trabajo debe especificar el alcance del servicio y sus condiciones.</p></div></div><div className="cp-fee-end"><p>No se publica una tarifa universal para litigio porque sería engañoso presentarla como aplicable a todos los asuntos.</p><a href={site.whatsapp} target="_blank" rel="noopener noreferrer">Consultar honorarios según tu caso ↗</a></div></div></section>
  </PageShell>;
}
