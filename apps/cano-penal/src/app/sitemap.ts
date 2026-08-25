import type { MetadataRoute } from "next";
import { areas } from "./content";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://canopenal.com";
  return [
    { url: `${base}/` },
    { url: `${base}/acerca-de-mi` },
    { url: `${base}/casos` },
    ...areas.map(([, href]) => ({ url: `${base}${href}` })),
    { url: `${base}/aviso-de-privacidad` }
  ];
}
