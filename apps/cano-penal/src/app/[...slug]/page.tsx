import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "../SiteChrome";
import { readCanoProgrammaticSeoPage } from "../../programmatic-seo";

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await readCanoProgrammaticSeoPage(slug);
  if (!page) return {};
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: page.canonicalUrl },
    robots: { index: page.indexable, follow: true },
  };
}

export default async function ProgrammaticSeoPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const page = await readCanoProgrammaticSeoPage(slug);
  if (!page) notFound();

  return (
    <PageShell>
      <section className="cp-page">
        <div className="cp-wrap cp-page-copy">
          <h1 className="cp-page-title">{page.heading}</h1>
          <div className="cp-copy" style={{ marginTop: "2.5rem" }}>
            <p>{page.bodyText}</p>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
