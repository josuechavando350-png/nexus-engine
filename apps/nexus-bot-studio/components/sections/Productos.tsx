"use client";

import Image from "next/image";
import { useRef } from "react";
import { Card } from "@/components/ui/Card";
import { Reveal } from "@/components/ui/Reveal";
import { useLoopScope } from "@/lib/useNexusMotion";

const products = [
  ["/sphere.webp", "sphere-icon", "Webs Premium", "Sitios de alto impacto visual. Construidos para crecer, posicionar y convertir."],
  ["/head.webp", "head-icon", "Agentes de IA", "Equipos de IA entrenados en tu realidad que automatizan, analizan y producen."],
  ["/arrows.webp", "arrows-icon", "Nexus Ventaja", "Inteligencia competitiva para crecer antes que la mayoría y tomar decisiones con claridad."],
] as const;

export function Productos() {
  const ref = useRef<HTMLElement | null>(null);
  useLoopScope(ref);
  return (
    <section ref={ref} className="section loop-scope" data-running="false" aria-labelledby="productos-title">
      <div className="section-inner">
        <Reveal><h2 id="productos-title" className="h2">TRES PRODUCTOS. UN MISMO SISTEMA. RESULTADOS REALES.</h2></Reveal>
        <Reveal delay={80}><p className="copy">Tres productos. Un mismo motor. Elige el sistema que se adapta.</p></Reveal>
        <div className="products-grid">
          {products.map(([src, animationClass, title, text], index) => (
            <Reveal key={title} delay={index * 80}>
              <Card className="product-card">
                <Image className={`product-icon ${animationClass}`} src={src} alt="" width={80} height={80} aria-hidden="true" />
                <div className="product-text"><h3>{title}</h3><p>{text}</p></div>
              </Card>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
