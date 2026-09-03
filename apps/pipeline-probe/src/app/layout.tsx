import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "NEXUS Pipeline Probe",
  description: "Disposable shell awaiting deterministic pipeline generation.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es-MX"><body>{children}</body></html>;
}
