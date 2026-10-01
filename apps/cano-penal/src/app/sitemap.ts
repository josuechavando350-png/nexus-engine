import type { MetadataRoute } from "next";
import { areas } from "./content";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://canopenal.com";
  const strategic = [
    "/defensa-penal-fiscal",
    "/defraudacion-fiscal",
    "/defensa-penal-empresarial",
    "/delitos-financieros",
    "/fraude-empresarial",
    "/representante-legal-investigacion-penal",
    "/detenido-cdmx",
    "/citatorio-ministerio-publico-cdmx",
    "/citatorio-fgr",
    "/orden-aprehension",
    "/audiencia-inicial",
    "/audiencia-inicial-control-detencion-cdmx",
    "/carpeta-investigacion",
    "/diagnostico-penal",
    "/evaluacion-empresarial",
    "/intelligence",
    "/acerca-de-mi",
    "/casos",
    "/guias/requerimiento-sat-riesgo-penal",
    "/guias/honorarios-abogado-penalista-cdmx",
    "/guias/responsabilidad-penal-representante-legal-contador",
    "/guias/defensa-penal-empresa-delitos-financieros",
    "/herramientas/calendario-fiscal",
    "/aviso-de-privacidad",
  ] as const;

  return [
    { url: `${base}/` },
    ...strategic.map((path) => ({ url: `${base}${path}` })),
    ...areas.map(([, href]) => ({ url: `${base}${href}` })),
  ];
}
