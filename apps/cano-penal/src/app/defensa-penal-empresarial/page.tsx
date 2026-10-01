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
    title="Defensa penal cuando también están en juego empresa, patrimonio y reputación."
    lead="Un expediente penal puede afectar simultáneamente personas, operaciones, información financiera y continuidad empresarial."
    marker="EMPRESA"
    context={[
      "La defensa empresarial requiere distinguir la posición de la organización de la de administradores, socios, representantes y asesores.",
      "No conviene tratar como un solo problema lo que puede contener conflictos societarios, financieros, contables, laborales y penales distintos."
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
    ctaTitle="El primer paso es separar el riesgo personal del riesgo de la empresa."
  /></PageShell>;
}
