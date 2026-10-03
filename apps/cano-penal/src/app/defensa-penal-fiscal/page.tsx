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
    title="Cuando lo fiscal empieza a adquirir dimensión penal."
    lead="La defensa penal-fiscal exige leer hechos, contabilidad, actos de autoridad y exposición personal dentro de una misma estrategia, sin confundir sus reglas."
    marker="PENAL FISCAL"
    context={[
      "No toda controversia fiscal constituye un asunto penal. La prioridad es identificar qué hechos, personas, documentos y autoridades pueden cambiar realmente el nivel de exposición.",
      "Cuando aparece una dimensión penal, la estrategia debe separar la posición de la empresa de la exposición individual de directivos, representantes y asesores."
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
    ctaTitle="Primero hay que determinar si existe una dimensión penal real y qué hechos la sostienen."
  /></PageShell>;
}
