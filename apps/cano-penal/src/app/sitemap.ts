import type { MetadataRoute } from "next";
import { areas } from "./content";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://canopenal.com";
  return [
    { url: `${base}/` },
    { url: `${base}/acerca-de-mi` },
    { url: `${base}/casos` },
    ...areas.map(([, href]) => ({ url: `${base}${href}` })),
    { url: `${base}/aviso-de-privacidad` },
    { url: `${base}/detenido-cdmx` },
    { url: `${base}/citatorio-ministerio-publico-cdmx` },
    { url: `${base}/audiencia-inicial-control-detencion-cdmx` },
    { url: `${base}/diagnostico-penal` },
    { url: `${base}/guias/requerimiento-sat-riesgo-penal` },
    { url: `${base}/guias/honorarios-abogado-penalista-cdmx` },
    { url: `${base}/guias/responsabilidad-penal-representante-legal-contador` },
    { url: `${base}/guias/defensa-penal-empresa-delitos-financieros` }
  ];
}
