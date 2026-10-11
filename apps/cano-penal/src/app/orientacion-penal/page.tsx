import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageShell } from "../SiteChrome";
import { superseoPaginas } from "../../superseo/paquete";
import "../[superseo]/superseo.css";

export function generateMetadata(): Metadata {
  if (!superseoPaginas().length) return {};
  return {
    title: "Orientación penal en CDMX | CANO Estrategia Penal",
    description: "Guías claras para saber qué hacer ante una detención, un citatorio, una orden de aprehensión u otra situación penal en la Ciudad de México.",
    alternates: { canonical: "https://canopenal.com/orientacion-penal" },
    robots: { index: true, follow: true },
  };
}

// Índice de las guías que SUPERSEO publicó. Si no hay ninguna, la página no existe.
export default function OrientacionPenalPage() {
  const paginas = superseoPaginas();
  if (!paginas.length) notFound();
  return (
    <PageShell>
      <section className="ss-hero">
        <div className="cp-wrap">
          <p className="cp-eyebrow">Orientación penal · Ciudad de México</p>
          <h1>Qué hacer en cada situación penal</h1>
          <p className="ss-lead">Guías escritas desde la práctica del despacho para entender el momento en el que estás y el siguiente paso.</p>
        </div>
      </section>
      <div className="cp-wrap ss-body">
        <ul className="ss-hub-list">
          {paginas.map((p) => (
            <li key={p.id}><Link href={p.ruta}><div>{p.h1}<span>{p.descripcion}</span></div></Link></li>
          ))}
        </ul>
      </div>
    </PageShell>
  );
}
