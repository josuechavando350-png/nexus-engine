import Image from "next/image";
import type React from "react";

const products = [
  ["AI", "Agentes inteligentes", "Chatbots y agentes de nueva generación que comprenden, verifican, recuerdan y aprenden para generar mejores oportunidades.", "Knowledge Graph · Guardrails · Memoria · Agents"],
  ["WEB", "Experiencias digitales", "Sitios web y plataformas de alto nivel, con una experiencia diseñada para convertir, escalar y permanecer.", "Experience DNA · Diseño · Rendimiento · Accesibilidad"],
  ["SEARCH", "Inteligencia SEO", "Una infraestructura SEO para descubrir oportunidades, aumentar visibilidad y atraer clientes de mayor valor.", "Módulos especializados · Intención · Demanda · Crecimiento"],
  ["QUANTUM ONE", "Cómputo avanzado", "Cómputo híbrido para explorar soluciones más avanzadas y resolver problemas complejos con mayor potencial.", "CPU · GPU · AI · QPU · Solver Tournament"],
] as const;
const quantum = ["CPU", "GPU", "AI", "QPU", "SOLVER", "WALLE", "PROOF", "MEJOR RESPUESTA"];
const infrastructure = [
  ["CONOCIMIENTO", "Knowledge Graph", "Grounding"], ["INTELIGENCIA", "Agentes", "Decisión"], ["CREACIÓN", "Experience DNA", "Design Genome"],
  ["WALLE", "VERIFICA TODO", ""], ["VERIFICACIÓN", "Visual Judge", "Accessibility"], ["CRECIMIENTO", "SEO Modules", "Opportunity Twin"], ["CÓMPUTO AVANZADO", "CPU · GPU · AI · QPU", ""],
] as const;

function ProductSigil({ kind }: { kind: (typeof products)[number][0] }) {
  if (kind === "AI") return <svg className="product-sigil" viewBox="0 0 120 120" aria-hidden="true"><path d="M60 17v86M60 38l-19 19M60 62l22-16M60 82l-14 11"/><circle cx="60" cy="17" r="3"/><circle cx="41" cy="57" r="3"/><circle cx="82" cy="46" r="3"/><circle cx="60" cy="62" r="3.5"/><circle cx="46" cy="93" r="3"/><circle cx="60" cy="103" r="3"/></svg>;
  if (kind === "WEB") return <svg className="product-sigil" viewBox="0 0 120 120" aria-hidden="true"><ellipse cx="52" cy="60" rx="29" ry="35"/><ellipse cx="69" cy="60" rx="29" ry="35"/><circle cx="41" cy="30" r="3"/><circle cx="86" cy="72" r="3"/><circle cx="60" cy="60" r="2.5"/></svg>;
  if (kind === "SEARCH") return <svg className="product-sigil" viewBox="0 0 120 120" aria-hidden="true"><path d="M60 19v82M19 60h82"/><circle cx="60" cy="19" r="3"/><circle cx="101" cy="60" r="3"/><circle cx="60" cy="101" r="3"/><circle cx="19" cy="60" r="3"/><circle cx="60" cy="60" r="4"/></svg>;
  return <svg className="product-sigil" viewBox="0 0 120 120" aria-hidden="true"><ellipse cx="60" cy="60" rx="46" ry="23" transform="rotate(-28 60 60)"/><path d="M24 81 96 39"/><circle cx="24" cy="81" r="3.5"/><circle cx="96" cy="39" r="3.5"/></svg>;
}

export default function HomePage() {
  return <main id="main-content">
    <section className="hero" aria-labelledby="hero-title">
      <Image src="/hero-editorial-v2.webp" alt="Interior arquitectónico nocturno con vista a la ciudad" fill priority quality={100} sizes="100vw" />
      <div className="hero-shade" />
      <header className="nav"><a href="#main-content" className="brand">NEXUS</a><nav aria-label="Principal"><a href="#systems">SYSTEMS</a><a href="#infrastructure">INTELLIGENCE</a><a href="#quantum">AUTOMATION</a><a href="#contact">RESULTS</a></nav></header>
      <div className="hero-copy"><h1 id="hero-title">Search engineered<br/>for dominance.</h1><p>Powered by technology developed by Nexus Research</p><a className="discover" href="#systems">DISCOVER <span /></a></div>
    </section>
    <section className="manifesto" id="systems"><div><p className="kicker">TECNOLOGÍA PROPIETARIA <i /></p><h2>No construimos<br/>servicios.<br/>Construimos<br/>sistemas.</h2></div><div className="manifesto-copy"><p>Nexus desarrolla tecnología propia para comprender, crear, verificar, optimizar y mejorar resultados reales de negocio.</p><p>Desde SEO de alto nivel hasta bots inteligentes y experiencias web, todo forma parte de una misma visión: construir sistemas más capaces.</p><div className="micro-grid"><span>SEO<small>POSICIONAR</small></span><span>BOTS<small>CONVERSAR</small></span><span>WEB<small>CONSTRUIR</small></span><span>RESEARCH<small>EVOLUCIONAR</small></span></div></div></section>
    <section className="products"><div className="products-heading"><p className="brand">NEXUS</p><h2>Una tecnología.<br/>Cuatro sistemas.</h2><p>Inteligencia, experiencia, posicionamiento y cómputo avanzado forman parte de una misma visión.</p></div><div className="product-grid">{products.map(([name,label,copy,tags])=><article key={name}><p className="brand">NEXUS</p><h3>{name}</h3><span>{label}</span><ProductSigil kind={name}/><p>{copy}</p><small>{tags}</small><a href="#contact">Saber más <i /></a></article>)}</div></section>
    <section className="quantum" id="quantum"><p className="kicker">NEXUS RESEARCH / ADVANCED COMPUTING <i /></p><div className="quantum-head"><div><h2>NEXUS<br/>QUANTUM ONE</h2><h3>Un problema. Todas las vías viables para resolverlo.</h3><p>Un sistema de cómputo híbrido diseñado para hacer competir algoritmos clásicos, GPU, inteligencia artificial y computación cuántica bajo un mismo objetivo medible.</p></div><ul><li>HYBRID RUNTIME</li><li>SOLVER TOURNAMENT</li><li>WALLE AUDIT</li><li>PROOF ENGINE</li><li>RESULTADOS REPRODUCIBLES</li></ul></div><div className="compute-line">{quantum.map((item,index)=><div className="compute-node" style={{"--delay":`${index*.42}s`} as React.CSSProperties} key={item}><i/><span>{item}</span></div>)}</div><div className="quantum-foot"><h3>Lo cuántico se gana su lugar.</h3><p>Si lo clásico gana, usamos lo clásico. Si lo cuántico demuestra ventaja, Nexus usa lo cuántico.</p></div></section>
    <section className="infrastructure" id="infrastructure"><p className="kicker">NEXUS RESEARCH / WALLE / INFRAESTRUCTURA <i /></p><h2>Construido bajo<br/>la superficie.</h2><p>Lo que el cliente ve es el resultado. Debajo existe una infraestructura diseñada para comprender, crear, verificar, medir y mejorar.</p><div className="infra-line">{infrastructure.map(([title,a,b],index)=><div className={`infra-node ${title==="WALLE"?"walle":""}`} style={{"--delay":`${index*.5}s`} as React.CSSProperties} key={title}><i/><strong>{title}</strong><span>{a}</span><span>{b}</span></div>)}</div><blockquote>Si no puede medirse, probarse<br/>o demostrarse, no pasa.</blockquote></section>
    <section className="contact" id="contact"><p className="brand">NEXUS</p><p className="topline">UNA INTELIGENCIA SUPERIOR PARA LO QUE SIGUE.</p><div><h2>Trae un problema difícil.</h2><p>Nexus construye sistemas para negocios que exigen inteligencia, rendimiento, verificación y cómputo avanzado.</p><a className="glow-button" href="https://wa.me/525643994476?text=Hola%20Nexus%20Bot%20Studio%2C%20quiero%20trabajar%20con%20ustedes." target="_blank" rel="noreferrer">TRABAJAR CON NEXUS</a><a className="text-link" href="#quantum">EXPLORAR QUANTUM ONE <i /></a></div><footer><span>Josué Villarreal, fundador de Nexus México</span><span>POWERED BY TECHNOLOGY DEVELOPED BY NEXUS RESEARCH</span></footer></section>
  </main>;
}
