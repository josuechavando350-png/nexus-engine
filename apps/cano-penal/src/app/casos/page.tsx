import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { cases } from "../content";

export const metadata: Metadata = {
  title: "Casos — abogado penalista CDMX",
  description: "Casos de defensa penal en CDMX, incluidos homicidio, delito fiscal, abuso sexual, despojo y corrupción."
};

export default function CasesPage() {
  return <PageShell><section className="cp-page"><div className="cp-wrap"><div className="cp-eyebrow">Casos</div><h1 className="cp-page-title">Casos</h1><div className="cp-cases">{cases.map(([title, body]) => <article className="cp-case" key={title}><h2>{title}</h2><p>{body}</p></article>)}</div></div></section></PageShell>;
}
