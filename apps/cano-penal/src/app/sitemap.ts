import type { MetadataRoute } from "next";
import { areas } from "./content";
import { highIntentLandings } from "./situaciones/content";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://canopenal.com";
  return [
    { url: `${base}/` },
    { url: `${base}/acerca-de-mi` },
    { url: `${base}/casos` },
    ...areas.map(([, href]) => ({ url: `${base}${href}` })),
    ...highIntentLandings.map(({ slug }) => ({ url: `${base}/situaciones/${slug}` })),
    { url: `${base}/aviso-de-privacidad` }
  ];
}
