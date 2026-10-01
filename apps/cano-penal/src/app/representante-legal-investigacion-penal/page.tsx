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
    title="El cargo no explica por sí solo la responsabilidad."
    lead="Firma, nombramiento y posición corporativa deben separarse de las decisiones, conocimiento y participación efectiva de cada persona."
    marker="RESPONSABILIDAD"
    context={[
      "Una investigación puede partir de documentos donde aparece un representante, administrador o contador sin que eso describa por completo su intervención.",
      "La defensa requiere reconstruir facultades, instrucciones, cadena de decisiones, acceso a información y actos concretos."
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
    ctaTitle="La defensa empieza por reconstruir qué hizo realmente cada persona."
  /></PageShell>;
}
