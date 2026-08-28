import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { REDUCED_MOTION_CSS, SR_ONLY_CSS, skipLinkProps, themeToCssVariables } from "@nexus/core";
import "@nexus/core/foundation/tokens/tokens.css";
import "./reset.css";
import "./a11y.css";
import "./styles.css";
import "./chrome.css";
import "./enhancements.css";
import "./client-feedback.css";
import { canoTheme } from "./theme";
import { site } from "./content";

export const metadata: Metadata = {
  title: {
    default: "Abogado penalista CDMX | CANO Estrategia Penal",
    template: "%s | CANO Estrategia Penal"
  },
  description: "Abogado penalista CDMX. Defensa penal estratégica en Ciudad de México y asuntos del fuero común y federal."
};

const themeStyle = themeToCssVariables(canoTheme) as CSSProperties;
const skipLink = skipLinkProps();

const attorneySchema = {
  "@context": "https://schema.org",
  "@type": "Attorney",
  name: site.lawyer,
  address: {
    "@type": "PostalAddress",
    streetAddress: "Montecito 38, piso 28, oficina 16, colonia Nápoles",
    addressLocality: "Benito Juárez",
    addressRegion: "CDMX",
    addressCountry: "MX"
  },
  telephone: site.phoneDisplay,
  email: site.email,
  areaServed: site.serviceArea
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es-MX">
      <head>
        <style dangerouslySetInnerHTML={{ __html: SR_ONLY_CSS }} />
        <style dangerouslySetInnerHTML={{ __html: REDUCED_MOTION_CSS }} />
        <script async src="https://www.googletagmanager.com/gtag/js?id=AW-11458109085" />
        <script dangerouslySetInnerHTML={{ __html: "window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','AW-11458109085');" }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(attorneySchema) }} />
      </head>
      <body style={themeStyle}>
        <div className="cp-splash" aria-hidden="true">
          <div className="cp-splash-inner">
            <div className="cp-splash-logo-wrap">
              <img className="cp-splash-logo" src="/media/logo-cano.png" alt="" />
            </div>
            <div className="cp-splash-line" />
            <p>EXPERIENCIA DESDE DENTRO. DEFENSA DE FRENTE.</p>
          </div>
        </div>
        <a {...skipLink}>Saltar al contenido principal</a>
        {children}
      </body>
    </html>
  );
}
