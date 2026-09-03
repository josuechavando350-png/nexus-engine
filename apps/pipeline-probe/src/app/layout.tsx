import type { Metadata } from "next";
import "./generated.css";
export const metadata: Metadata = { title: "CANO Estrategia Penal", description: "Defensa penal estratégica en Ciudad de México y asuntos del fuero común y federal, con experiencia previa dentro de la autoridad." };
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="es-MX"><body>{children}</body></html>}
