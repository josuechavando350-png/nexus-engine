import type { Metadata } from "next";
import { SR_ONLY_CSS, skipLinkProps } from "@nexus/core";

export const metadata: Metadata = {
  title: "NEXUS Pipeline Probe",
  description: "Disposable shell awaiting deterministic pipeline generation.",
};

const skipLink = skipLinkProps();

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es-MX">
      <head><style dangerouslySetInnerHTML={{ __html: SR_ONLY_CSS }} /></head>
      <body><a {...skipLink}>Saltar al contenido principal</a>{children}</body>
    </html>
  );
}
