import type { Metadata } from "next";
import type { CSSProperties } from "react";
import {
  REDUCED_MOTION_CSS,
  SR_ONLY_CSS,
  skipLinkProps,
  themeToCssVariables
} from "@nexus/core";
import "@nexus/core/foundation/tokens/tokens.css";
import "./reset.css";
import "./a11y.css";
import "./styles.css";
import { nexusBotTheme } from "./theme";

export const metadata: Metadata = {
  title: "Nexus Bot Studio — probe",
  description:
    "NEXUS V1.1 experience probe. Demo content only — not the production site."
};

const themeStyle = themeToCssVariables(nexusBotTheme) as CSSProperties;
const skipLink = skipLinkProps();

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <head>
        <style dangerouslySetInnerHTML={{ __html: SR_ONLY_CSS }} />
        <style dangerouslySetInnerHTML={{ __html: REDUCED_MOTION_CSS }} />
      </head>
      <body style={themeStyle}>
        <a {...skipLink}>Saltar al contenido principal</a>
        {children}
      </body>
    </html>
  );
}
