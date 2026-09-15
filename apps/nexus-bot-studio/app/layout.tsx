import type { Metadata } from "next";
import "./globals.css";
import { SplashScreen } from "@/components/SplashScreen";
import { WhatsAppButton } from "@/components/WhatsAppButton";

export const metadata: Metadata = {
  metadataBase: new URL("https://nexusbotstudio.com"),
  title: "Nexus Bot Studio — Tecnología para negocios",
  description: "Tecnología propia para SEO, agentes inteligentes, experiencias web y cómputo avanzado.",
  alternates: { canonical: "/" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es-MX">
      <body>
        <SplashScreen />
        <a className="skip-link" href="#main-content">Saltar al contenido</a>
        {children}
        <WhatsAppButton />
      </body>
    </html>
  );
}
