import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";

export const metadata: Metadata = {
  title: "Aviso de privacidad — abogado penalista CDMX",
  description: "Aviso de privacidad de CANO Estrategia Penal."
};

export default function PrivacyPage() {
  return <PageShell><section className="cp-page"><div className="cp-wrap cp-page-copy"><div className="cp-eyebrow">Aviso de privacidad</div><h1 className="cp-page-title">Aviso de privacidad</h1><div className="cp-pending">Contenido pendiente.</div></div></section></PageShell>;
}
