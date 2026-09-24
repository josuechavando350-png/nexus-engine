import type { Metadata } from "next";
import { InteriorHero } from "../InteriorSections";
import { PageShell } from "../SiteChrome";

export const metadata: Metadata = {
  title: "Aviso de privacidad — abogado penalista CDMX",
  description: "Aviso de privacidad de CANO Estrategia Penal."
};

export default function PrivacyPage() {
  return (
    <PageShell>
      <InteriorHero
        eyebrow="Información legal"
        title="Aviso de privacidad"
        lead="La confidencialidad forma parte del trabajo jurídico y también del manejo de la información que compartes con el despacho."
        marker="Privacidad"
      />

      <section className="cp-interior-body">
        <div className="cp-wrap cp-privacy-premium">
          <div className="cp-privacy-copy">
            <p>La información proporcionada en este sitio será tratada con estricta confidencialidad y utilizada únicamente para brindar atención jurídica y contacto relacionado con los servicios legales solicitados.</p>
            <p>No compartimos información personal con terceros sin autorización del titular, salvo obligación legal.</p>
            <p>Si deseas conocer el aviso de privacidad integral, puedes solicitarlo directamente por correo electrónico.</p>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
