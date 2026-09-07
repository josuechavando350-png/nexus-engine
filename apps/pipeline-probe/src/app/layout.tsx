import type { Metadata } from "next";
import { headers } from "next/headers";
import "./generated.css";
import { Cortex08PrerenderClient } from "./Cortex08PrerenderClient";
import { Cortex09FrictionClient } from "./Cortex09FrictionClient";
import { Cortex13CwvClient } from "./Cortex13CwvClient";

export const metadata: Metadata = { title: "CANO Estrategia Penal", description: "Defensa penal estratégica en Ciudad de México y asuntos del fuero común y federal, con experiencia previa dentro de la autoridad." };

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const prebuild = requestHeaders.get("x-nexus-cortex33-prebuild");
  const edge = requestHeaders.get("x-nexus-cortex33-edge");
  const source = requestHeaders.get("x-nexus-cortex33-source");
  const valid = Boolean(prebuild && edge && source && SHA256.test(prebuild) && SHA256.test(edge) && SHA.test(source));
  return <html lang="es-MX">
    <head>{valid ? <>
      <meta name="nexus-cortex33-prebuild" content={prebuild!} />
      <meta name="nexus-cortex33-edge" content={edge!} />
      <meta name="nexus-cortex33-source" content={source!} />
    </> : null}</head>
    <body><a className="nexus-skip-link" href="#main-content">Saltar al contenido</a><Cortex08PrerenderClient /><Cortex09FrictionClient /><Cortex13CwvClient />{children}</body>
  </html>;
}
