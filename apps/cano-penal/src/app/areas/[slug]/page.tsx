import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { approvedCanoArea } from "../../../approved-programmatic-seo";
import { readCanoProgrammaticSeoPage } from "../../../programmatic-seo";
import { mergeSerpMetadata, readSerpMetadataOverride } from "../../../serp-metadata-control";
import { PageShell } from "../../SiteChrome";

export function generateStaticParams() {
  const slugs = [
    "delitos-fiscales-y-financieros",
    "delitos-patrimoniales-y-fraude",
    "homicidio-y-delitos-violentos",
    "delitos-sexuales",
    "corrupcion-y-administracion-publica",
    "despojo-y-defensa-de-victimas",
    "justicia-penal-para-adolescentes",
    "amparo-recursos-y-apelaciones",
  ] as const;
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const approved = approvedCanoArea(slug);
  if (!approved) return {};
  const governed = await readCanoProgrammaticSeoPage(["areas", slug]);
  const page = governed ?? approved.page;
  const fallback: Metadata = {
    title: page.title,
    description: page.description,
    alternates: { canonical: new URL(`areas/${slug}/`, "https://canopenal.com/").toString() },
    robots: { index: true, follow: true },
  };
  const pageUrl = `https://canopenal.com/areas/${slug}`;
  return mergeSerpMetadata(fallback, await readSerpMetadataOverride(slug, pageUrl));
}

export default async function AreaPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const approved = approvedCanoArea(slug);
  if (!approved) notFound();
  const governed = await readCanoProgrammaticSeoPage(["areas", slug]);
  const heading = governed?.heading ?? approved.name;
  const paragraphs = governed?.distinctiveStatements ?? approved.paragraphs;

  return (
    <PageShell>
      <section className="cp-page">
        <div className="cp-wrap cp-page-copy">
          <div className="cp-eyebrow">Área de práctica</div>
          <h1 className="cp-page-title">{heading}</h1>
          <div className="cp-copy" style={{ marginTop: "2.5rem" }}>
            {paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </div>
        </div>
      </section>
    </PageShell>
  );
}
