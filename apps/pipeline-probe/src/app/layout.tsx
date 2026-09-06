import type { Metadata } from "next";
import "./generated.css";
import { Cortex08PrerenderClient } from "./Cortex08PrerenderClient";
import { Cortex13CwvClient } from "./Cortex13CwvClient";

export const metadata: Metadata = { title: "CANO Estrategia Penal", description: "Defensa penal estratégica en Ciudad de México y asuntos del fuero común y federal, con experiencia previa dentro de la autoridad." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="es-MX"><body><a className="nexus-skip-link" href="#main-content">Saltar al contenido</a><Cortex08PrerenderClient /><Cortex13CwvClient />{children}</body></html>;
}
