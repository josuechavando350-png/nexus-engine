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
    title="El dinero deja rastros. La estrategia empieza por reconstruirlos."
    lead="Operaciones, autorizaciones, cuentas, contratos y decisiones deben leerse como una secuencia verificable, no como etiquetas genéricas."
    marker="FINANCIERO"
    context={[
      "Las investigaciones financieras suelen depender de documentación y relaciones entre múltiples personas y operaciones. El contexto importa tanto como cada movimiento aislado.",
      "La defensa debe distinguir quién decidió, quién ejecutó, quién conocía y qué información tenía disponible cada participante."
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
    ctaTitle="Antes de responder a una imputación financiera hay que reconstruir la operación completa."
  /></PageShell>;
}
