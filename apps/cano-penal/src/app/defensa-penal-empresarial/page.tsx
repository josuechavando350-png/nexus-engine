import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { StrategicLanding } from "../StrategicLanding";

export const metadata: Metadata = {
  title: "Defensa penal empresarial en CDMX | CANO Estrategia Penal",
  description: "Defensa penal para empresas, directivos y representantes ante investigaciones, fraude, delitos financieros y exposición corporativa.",
  alternates: { canonical: "https://canopenal.com/defensa-penal-empresarial" },
};

export default function CorporateDefensePage() {
  return <PageShell><StrategicLanding
    eyebrow="Empresas y directivos"
    title="Defensa penal cuando el expediente también amenaza patrimonio, empresa y reputación."
    lead="Un expediente penal puede comprometer simultáneamente personas, decisiones, información financiera, patrimonio y continuidad empresarial."
    marker="EMPRESA"
    context={[
      "La defensa empresarial exige separar con precisión la posición de la organización de la exposición personal de administradores, socios, representantes y asesores.",
      "Cuando un asunto mezcla frentes societarios, financieros, contables o contractuales, convertirlos en un solo problema penal suele borrar diferencias que son estratégicamente importantes."
    ]}
    scenarios={[
      { title: "Investigaciones a directivos", copy: "Definición de exposición individual, funciones reales, decisiones adoptadas y documentación disponible." },
      { title: "Fraude y administración", copy: "Reconstrucción de operaciones, flujos de dinero, autorizaciones y conflictos internos con posible dimensión penal." },
      { title: "Crisis penal corporativa", copy: "Coordinación de decisiones jurídicas y operativas cuando el expediente puede afectar a la organización." }
    ]}
    related={[
      { label: "Fraude empresarial", href: "/fraude-empresarial" },
      { label: "Delitos financieros", href: "/delitos-financieros" },
      { label: "Evaluación empresarial confidencial", href: "/evaluacion-empresarial" }
    ]}
    ctaTitle="El primer paso es distinguir qué riesgo pertenece a la persona, cuál a la empresa y qué requiere atención inmediata."
  /></PageShell>;
}
