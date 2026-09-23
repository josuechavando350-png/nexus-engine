import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "../SiteChrome";
import { ContactForm } from "../ContactForm";
import { site } from "../content";

export const metadata: Metadata = {
  title: "Diagnóstico penal en CDMX | Consulta con Eduardo Cano",
  description: "Valoración presencial y estudio inicial de una situación penal. Diagnóstico y estrategia: $2,500 MXN. Contacta a CANO.",
  alternates: { canonical: "https://canopenal.com/diagnostico-penal" },
};

const steps = [
  ["El contexto", "Comenzamos por conocer el problema general y el momento procesal."],
  ["La valoración", "Revisamos la información relevante para orientar los siguientes pasos."],
  ["La estrategia", "Hablamos de las alternativas de actuación que correspondan a tu situación."],
] as const;

export default function DiagnosticoPage() {
  return (
    <PageShell>
      <section className="cp-dx-hero">
        <div className="cp-wrap cp-dx-hero-grid">
          <div className="cp-dx-lead-column">
            <p className="cp-eyebrow">Consulta presencial · Ciudad de México</p>
            <h1>Primero la claridad.<br/><em>Después la decisión.</em></h1>
            <p>Una consulta penal no debería dejarte con más dudas. El diagnóstico permite estudiar la situación inicial y conversar sobre la estrategia.</p>
            <div className="cp-dx-hero-links">
              <a href={site.whatsapp} target="_blank" rel="noopener noreferrer">Solicitar diagnóstico ↗</a>
              <Link href="/guias/honorarios-abogado-penalista-cdmx">Entender los honorarios ↗</Link>
            </div>
          </div>
          <div className="cp-dx-price-panel">
            <span className="cp-dx-price-top">Diagnóstico y estrategia</span>
            <strong><small>MXN</small> $2,500</strong>
            <p>Valoración y estudio inicial presencial. Sin límite de tiempo para la consulta, de acuerdo con la modalidad publicada por el despacho.</p>
            <span className="cp-dx-price-rule" aria-hidden="true"/>
            <p className="cp-dx-price-note">Este monto corresponde al diagnóstico, no a la defensa integral del asunto. Los honorarios posteriores se acuerdan por separado.</p>
          </div>
        </div>
      </section>
      <section className="cp-dx-process">
        <div className="cp-wrap">
          <div className="cp-dx-heading"><p className="cp-eyebrow">En la consulta</p><h2>Una conversación<br/>con dirección.</h2></div>
          <div className="cp-dx-steps">{steps.map(([title,copy],i)=>(
            <article key={title}><span>0{i+1}</span><h3>{title}</h3><p>{copy}</p></article>
          ))}</div>
        </div>
      </section>
      <section className="cp-dx-form-section">
        <div className="cp-wrap cp-dx-form-grid">
          <div><p className="cp-eyebrow">Contacto privado</p><h2>Cuéntanos<br/><em>cómo localizarte.</em></h2><p>No necesitamos recibir documentos ni detalles sensibles en este formulario. Se abrirá WhatsApp para que decidas si deseas enviar el mensaje.</p></div>
          <ContactForm/>
        </div>
      </section>
    </PageShell>
  );
}
