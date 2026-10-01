import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "../SiteChrome";

export const metadata: Metadata = {
  title: "CANO Intelligence | Penal económico, fiscal y empresarial",
  description: "Análisis de riesgo penal, fiscal, financiero y empresarial desde la experiencia de investigación y defensa.",
  alternates: { canonical: "https://canopenal.com/intelligence" },
};

const briefings = [
  {
    href: "/guias/requerimiento-sat-riesgo-penal",
    eyebrow: "Penal fiscal",
    title: "Cuándo un requerimiento del SAT empieza a exigir lectura penal.",
    copy: "No todo conflicto fiscal es penal. El problema es detectar a tiempo qué hechos, documentos y autoridades cambian el nivel de exposición.",
  },
  {
    href: "/guias/responsabilidad-penal-representante-legal-contador",
    eyebrow: "Administradores y asesores",
    title: "Representantes legales y contadores frente a una investigación.",
    copy: "Cargo, firma y participación no significan automáticamente la misma responsabilidad. La reconstrucción precisa de funciones y decisiones importa.",
  },
  {
    href: "/guias/defensa-penal-empresa-delitos-financieros",
    eyebrow: "Empresa",
    title: "Una investigación puede afectar mucho más que el expediente.",
    copy: "Defensa personal, continuidad operativa, información financiera y reputación pueden coexistir dentro del mismo problema.",
  },
] as const;

export default function IntelligencePage() {
  return <PageShell>
    <section className="cp-intel-hero">
      <div className="cp-wrap cp-intel-hero-grid">
        <div><p className="cp-eyebrow">CANO Intelligence</p><h1>Entender cómo se construye el riesgo antes de reaccionar.</h1></div>
        <div><p>Análisis para empresarios, directivos y particulares sobre investigaciones, decisiones procesales y exposición penal. Sin promesas de resultado y sin contenido genérico disfrazado de especialización.</p></div>
      </div>
    </section>
    <section className="cp-intel-index">
      <div className="cp-wrap">
        {briefings.map((item)=><Link className="cp-intel-entry" href={item.href} key={item.href} data-nexus-signal="intelligence-article">
          <div><span>{item.eyebrow}</span><h2>{item.title}</h2></div>
          <p>{item.copy}</p>
          <i aria-hidden="true">↗</i>
        </Link>)}
      </div>
    </section>
    <section className="cp-intel-method">
      <div className="cp-wrap cp-intel-method-grid">
        <div><p className="cp-eyebrow">Criterio editorial</p><h2>Experiencia, norma, procedimiento y hechos <strong>por separado.</strong></h2></div>
        <div><p>Cada publicación debe distinguir lo que deriva de una norma, lo que depende de hechos concretos y lo que corresponde a experiencia profesional. El contenido informa; no sustituye el análisis particular de un asunto.</p></div>
      </div>
    </section>
  </PageShell>;
}
