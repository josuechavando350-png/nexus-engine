import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "../../SiteChrome";
import { areas } from "../../content";

const areaMap = Object.fromEntries(areas.map(([name, href]) => [href.split("/").pop()!, name]));

export function generateStaticParams() {
  return Object.keys(areaMap).map(slug => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const name = areaMap[slug];
  if (!name) return {};
  const fiscal = slug === "delitos-fiscales-y-financieros";
  return {
    title: `${name} — ${fiscal ? "abogado delitos fiscales CDMX" : "abogado penalista CDMX"}`,
    description: `${name}. ${fiscal ? "Abogado delitos fiscales CDMX" : "Abogado penalista CDMX"}.`
  };
}

export default async function AreaPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const name = areaMap[slug];
  if (!name) notFound();
  return <PageShell><section className="cp-page"><div className="cp-wrap cp-page-copy"><div className="cp-eyebrow">Área de práctica</div><h1 className="cp-page-title">{name}</h1><div className="cp-pending">Contenido pendiente.</div></div></section></PageShell>;
}
