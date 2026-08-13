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
import "./a11y-gap.css";
import { assertRequiredTheme } from "./theme-contract";
import { experienceSeedTheme } from "./theme";

export const metadata: Metadata = {
  title: "NEXUS Experience Seed",
  description:
    "Neutral starting point for a new NEXUS Experience. Not themed. Not a template to clone visually."
};

// Fails loudly at build/render time if a required token role is missing.
// See theme-contract.ts for why this exists instead of a silent fallback.
assertRequiredTheme(experienceSeedTheme);

const themeStyle = themeToCssVariables(experienceSeedTheme) as CSSProperties;
const skipLink = skipLinkProps();

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <head>
        {/* Rendered directly from Core's exported constants — not copied. */}
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
