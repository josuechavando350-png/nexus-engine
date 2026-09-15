"use client";

import { useRef } from "react";
import { Reveal } from "@/components/ui/Reveal";
import { useLoopScope } from "@/lib/useNexusMotion";

const lines = [["NO", "ES", "SUERTE."], ["ES", "INGENIERÍA."]];

export function Frase() {
  const ref = useRef<HTMLElement | null>(null);
  useLoopScope(ref);
  let index = 0;
  return (
    <section ref={ref} className="section phrase loop-scope" data-running="false" aria-label="No es suerte. Es ingeniería.">
      <div className="section-inner phrase-stage">
        <div className="phrase-ring" aria-hidden="true" />
        <div className="phrase-light" aria-hidden="true" />
        <div className="phrase-glow" aria-hidden="true" />
        <h2 className="h2 phrase-copy">
          {lines.map((line, lineIndex) => (
            <span className="phrase-line" key={lineIndex}>
              {line.map((word) => { const delay = index++ * 150; return <Reveal key={`${word}-${delay}`} as="span" className="phrase-word" delay={delay}>{word}</Reveal>; })}
            </span>
          ))}
        </h2>
      </div>
    </section>
  );
}
