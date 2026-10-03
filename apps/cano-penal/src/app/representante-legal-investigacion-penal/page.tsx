import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { StrategicLanding } from "../StrategicLanding";

export const metadata: Metadata = {
  title: "Representante legal ante investigación penal | CANO",
  description: "Defensa para representantes legales, administradores y contadores ante investigaciones penales relacionadas con decisiones empresariales o fiscales.",
  alternates: { canonical: "https://canopenal.com/representante-legal-investigacion-penal" },
};

export default function RepresentativePage() {
  return <PageShell><StrategicLanding
    eyebrow="Representantes y administradores"
    title="El cargo importa. La participación real importa más."
    lead="Firma, nombramiento y posición corporativa no sustituyen el análisis de decisiones, conocimiento y participación efectiva de cada persona."
    marker="RESPONSABILIDAD"
    context={[
      "Una investigación puede partir de documentos donde aparece un representante, administrador o contador. Eso, por sí solo, no describe toda su intervención ni el contexto de sus decisiones.",
      "La defensa requiere reconstruir facultades, instrucciones, cadena de decisiones, acceso real a información y actos concretos."
    ]}
    scenarios={[
      { title: "Representante legal", copy: "Análisis de facultades formales frente a decisiones realmente adoptadas y ejecutadas." },
      { title: "Administrador o directivo", copy: "Revisión de gobierno corporativo, autorizaciones, controles y nivel real de intervención." },
      { title: "Contador o asesor", copy: "Separación entre trabajo técnico, información recibida y decisiones que correspondían a otras personas." }
    ]}
    related={[
      { label: "Responsabilidad de representantes y contadores", href: "/guias/responsabilidad-penal-representante-legal-contador" },
      { label: "Defensa penal fiscal", href: "/defensa-penal-fiscal" },
      { label: "Evaluación empresarial", href: "/evaluacion-empresarial" }
    ]}
    ctaTitle="La defensa empieza por separar el cargo formal de lo que cada persona hizo, supo y decidió realmente."
  /></PageShell>;
}
