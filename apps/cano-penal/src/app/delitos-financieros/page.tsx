import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { StrategicLanding } from "../StrategicLanding";

export const metadata: Metadata = {
  title: "Delitos financieros en CDMX | Defensa penal estratégica",
  description: "Defensa penal en investigaciones financieras, patrimoniales y corporativas con revisión de operaciones, documentación y participación individual.",
  alternates: { canonical: "https://canopenal.com/delitos-financieros" },
};

export default function FinancialCrimesPage() {
  return <PageShell><StrategicLanding
    eyebrow="Delitos financieros"
    title="El dinero deja rastros. La defensa empieza por entenderlos."
    lead="Operaciones, autorizaciones, cuentas, contratos y decisiones deben reconstruirse como una secuencia verificable, no reducirse a etiquetas."
    marker="FINANCIERO"
    context={[
      "En una investigación financiera, una operación aislada rara vez cuenta toda la historia. Documentación, relaciones, facultades y secuencia temporal forman parte del contexto que debe reconstruirse.",
      "La defensa debe distinguir quién decidió, quién ejecutó, qué conocía cada participante y qué información tenía realmente disponible en cada momento."
    ]}
    scenarios={[
      { title: "Operaciones cuestionadas", copy: "Revisión de origen, destino, autorización, soporte documental y explicación económica de las transacciones." },
      { title: "Fraude y patrimonio", copy: "Separación entre incumplimiento, conflicto corporativo y conducta penalmente relevante." },
      { title: "Investigación de participantes", copy: "Reconstrucción de funciones y grado de intervención de directivos, empleados, asesores y terceros." }
    ]}
    related={[
      { label: "Defensa penal empresarial", href: "/defensa-penal-empresarial" },
      { label: "Fraude empresarial", href: "/fraude-empresarial" },
      { label: "Trayectoria de Eduardo Cano", href: "/acerca-de-mi" }
    ]}
    ctaTitle="Antes de responder, hay que reconstruir la operación y la participación real de cada persona."
  /></PageShell>;
}
