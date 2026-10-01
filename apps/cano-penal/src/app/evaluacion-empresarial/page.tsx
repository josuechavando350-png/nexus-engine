import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { EnterpriseIntakeForm } from "./EnterpriseIntakeForm";

export const metadata: Metadata = {
  title: "Evaluación penal empresarial y fiscal | CANO",
  description: "Evaluación confidencial para empresas, directivos, representantes y profesionales frente a riesgos penales, fiscales o financieros.",
  alternates: { canonical: "https://canopenal.com/evaluacion-empresarial" },
};

export default function EnterpriseEvaluationPage() {
  return <PageShell>
    <section className="cp-enterprise-hero">
      <div className="cp-wrap cp-enterprise-hero-grid">
        <div>
          <p className="cp-eyebrow">Evaluación confidencial</p>
          <h1>Cuando el asunto penal también puede afectar empresa, patrimonio y reputación.</h1>
        </div>
        <div>
          <p>No todos los asuntos deben entrar por una consulta estándar. Esta vía está pensada para empresarios, directivos, representantes legales, contadores y organizaciones que necesitan entender exposición, urgencia y siguiente movimiento.</p>
        </div>
      </div>
    </section>
    <section className="cp-section">
      <div className="cp-wrap cp-enterprise-process">
        <div><p className="cp-eyebrow">Qué ocurre después</p><h2>Primero se determina si el asunto requiere <strong>intervención inmediata.</strong></h2></div>
        <div className="cp-enterprise-steps">
          <article><h3>Contexto</h3><p>Identificamos autoridad, etapa, personas involucradas y plazo relevante sin pedir información sensible innecesaria.</p></article>
          <article><h3>Riesgo</h3><p>Separa riesgo penal personal, riesgo corporativo y consecuencias operativas para evitar respuestas improvisadas.</p></article>
          <article><h3>Estrategia</h3><p>Si el asunto es atendible, el despacho define el siguiente paso y el canal adecuado para documentos y análisis.</p></article>
        </div>
      </div>
    </section>
    <section className="cp-enterprise-form-section">
      <div className="cp-wrap cp-enterprise-form-grid">
        <div><p className="cp-eyebrow">Primer contacto</p><h2>Comparte sólo lo indispensable.</h2><p>La confidencialidad empieza reduciendo la cantidad de información sensible que circula antes de revisar el asunto.</p></div>
        <EnterpriseIntakeForm />
      </div>
    </section>
  </PageShell>;
}
