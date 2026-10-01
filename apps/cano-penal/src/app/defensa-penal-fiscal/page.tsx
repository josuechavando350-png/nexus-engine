import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { StrategicLanding } from "../StrategicLanding";

export const metadata: Metadata = {
  title: "Defensa penal fiscal en CDMX | CANO Estrategia Penal",
  description: "Defensa penal fiscal en investigaciones relacionadas con hechos tributarios, financieros y posibles consecuencias penales.",
  alternates: { canonical: "https://canopenal.com/defensa-penal-fiscal" },
};

export default function PenalFiscalPage() {
  return <PageShell><StrategicLanding
    eyebrow="Defensa penal fiscal"
    title="Cuando el problema deja de ser sólo tributario."
    lead="La defensa penal-fiscal exige leer hechos, contabilidad, autoridad y riesgo personal como partes del mismo expediente."
    marker="PENAL FISCAL"
    context={[
      "No toda controversia fiscal constituye un asunto penal. La prioridad es identificar qué hechos, personas, documentos y autoridades están realmente involucrados.",
      "Cuando existe una investigación penal o riesgo de que el asunto escale, la estrategia debe separar la posición de la empresa de la exposición individual de directivos, representantes y asesores."
    ]}
    scenarios={[
      { title: "Investigación fiscal con dimensión penal", copy: "Revisión de antecedentes, actos de autoridad, documentación contable y posibles líneas de investigación." },
      { title: "Directivos y representantes", copy: "Reconstrucción de funciones, decisiones, firmas y participación real para evitar atribuciones genéricas." },
      { title: "Coordinación de defensa", copy: "El frente fiscal y el penal deben sostener una estrategia coherente sin confundir sus objetivos ni procedimientos." }
    ]}
    related={[
      { label: "Defraudación fiscal", href: "/defraudacion-fiscal" },
      { label: "Requerimientos del SAT y riesgo penal", href: "/guias/requerimiento-sat-riesgo-penal" },
      { label: "Evaluación empresarial confidencial", href: "/evaluacion-empresarial" }
    ]}
    ctaTitle="Primero hay que determinar si el asunto ya tiene una dimensión penal real."
  /></PageShell>;
}
