import type { Metadata } from "next";
import type { CSSProperties } from "react";
import {
  skipLinkProps,
  themeToCssVariables
} from "@nexus/core";
import "@nexus/core/foundation/tokens/tokens.css";
import "./globals.css";
import "./motion.css";
import "./footer.css";
import { nexusTheme } from "./nexus-theme";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

export const metadata: Metadata = {
  title: "NEXUS Client",
  description: "NEXUS Web Engine client template"
};

const themeStyle = themeToCssVariables(nexusTheme) as CSSProperties;
const skipLink = skipLinkProps();

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body style={themeStyle}>
        <a {...skipLink}>Saltar al contenido principal</a>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
