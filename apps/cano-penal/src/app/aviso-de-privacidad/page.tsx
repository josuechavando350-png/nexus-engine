import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";

export const metadata: Metadata = {
  title: "Aviso de privacidad — abogado penalista CDMX",
  description: "Aviso de privacidad de CANO Estrategia Penal."
};

export default function PrivacyPage() {
  return (
    <PageShell>
      <section className="cp-page">
        <div className="cp-wrap cp-page-copy">
          <div className="cp-eyebrow">Aviso de privacidad</div>
          <h1 className="cp-page-title">Aviso de Privacidad | Cano Estrategia Penal</h1>
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
