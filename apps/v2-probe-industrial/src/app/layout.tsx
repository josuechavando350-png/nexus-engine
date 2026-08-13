import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { FOCUS_VISIBLE_CSS, NEXUS_RESET_CSS, REDUCED_MOTION_CSS, SKIP_LINK_CSS, SR_ONLY_CSS, skipLinkProps, themeToCssVariables } from "@nexus/core";
import "@nexus/core/foundation/tokens/tokens.css";
import "./styles.css";
import { probeTheme } from "./theme";

export const metadata: Metadata = { title: "Industrial Probe \u2014 NEXUS V2", description: "V2 expressiveness probe: dense industrial operations/index composition." };
const themeStyle = themeToCssVariables(probeTheme) as CSSProperties;
const skipLink = skipLinkProps();

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <head>
        <style dangerouslySetInnerHTML={{ __html: `${NEXUS_RESET_CSS}\n${SR_ONLY_CSS}\n${SKIP_LINK_CSS}\n${FOCUS_VISIBLE_CSS}\n${REDUCED_MOTION_CSS}` }} />
      </head>
      <body style={themeStyle}>
        <a {...skipLink}>Saltar al contenido principal</a>
        {children}
      </body>
    </html>
  );
}
