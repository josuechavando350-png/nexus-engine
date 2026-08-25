import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { academics, trajectory } from "../content";

export const metadata: Metadata = {
  title: "Acerca de mí — abogado penalista CDMX",
  description: "Trayectoria de Eduardo Cano, abogado penalista CDMX con experiencia en delitos fiscales y defensa penal."
};

export default function AboutPage() {
  return (
    <PageShell>
      <section className="cp-page"><div className="cp-wrap cp-page-copy"><div className="cp-eyebrow">Acerca de mí</div><h1 className="cp-page-title">Eduardo Cano</h1><p>{trajectory}</p><ul className="cp-list">{academics.map(item => <li key={item}>{item}</li>)}</ul></div></section>
    </PageShell>
  );
}
