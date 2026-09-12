import type { Metadata } from "next";
import "@fontsource/archivo/800.css";
import "@fontsource/archivo/900.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "./globals.css";
import { Footer } from "@/components/sections/Footer";
import { MotionRuntime } from "@/components/ui/MotionRuntime";

export const metadata: Metadata = {
  title: "Nexus Bot Studio",
  description: "Nexus Bot Studio crea sistemas digitales, webs premium, agentes de IA y automatización para negocios en México.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es-MX">
      <body>
        <a className="skip-link" href="#contenido">Saltar al contenido</a>
        <header className="site-header">
          <a className="brand-link" href="#contenido" aria-label="Nexus Bot Studio, inicio">NEXUS</a>
          <a className="header-cta" href="#contacto">HABLEMOS →</a>
        </header>
        <MotionRuntime />
        <main id="contenido" className="site-shell">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
