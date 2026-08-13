import { plan } from "./experience";

const essays = [
  ["01", "The room before the object", "Space is treated as an argument: margin, silence, then evidence."],
  ["02", "Material as memory", "A sequence of fragments carries proof without turning every fragment into a product tile."],
  ["03", "A slower conversion", "The action arrives after the reader understands the point of view." ]
] as const;

export default function Page() {
  return (
    <main id="main-content" className="ed-shell" data-recipe={plan.recipeId}>
      <header className="ed-masthead">
        <a className="ed-wordmark" href="#manifesto">ÉDITIONS 27</a>
        <nav aria-label="Índice editorial" className="ed-index">
          <a href="#manifesto">Manifesto</a><a href="#essays">Notes</a><a href="#contact">Contact</a>
        </nav>
        <span className="ed-issue">ISSUE / 02</span>
      </header>

      <section id="manifesto" className="ed-opening">
        <div className="ed-kicker">AN INDEPENDENT READING OBJECT</div>
        <h1>Not everything valuable should arrive shouting.</h1>
        <p className="ed-deck">A V2 probe where hierarchy is made from reading tempo, margin and sequence—not a hero stack.</p>
        <aside className="ed-marginalia">NEXUS V2 / editorial-sequence<br/>No cards. No pill CTA. No centered opening.</aside>
      </section>

      <section id="essays" className="ed-essays" aria-labelledby="notes-heading">
        <h2 id="notes-heading" className="ed-section-title">Field notes</h2>
        {essays.map(([index, title, copy]) => (
          <article className="ed-entry" key={index}>
            <span className="ed-number">{index}</span>
            <h3>{title}</h3>
            <p>{copy}</p>
            <span className="ed-read">Read note ↗</span>
          </article>
        ))}
      </section>

      <figure className="ed-figure">
        <div className="ed-image-field" aria-hidden="true"><span>DOCUMENT / 27</span></div>
        <figcaption>Image is evidence inside the essay, not a decorative banner.</figcaption>
      </figure>

      <section id="contact" className="ed-contact">
        <span className="ed-number">04</span>
        <div><h2>Continue the conversation.</h2><p>For editions, collaborations and private circulation.</p></div>
        <a href="mailto:studio@example.com" className="ed-contact-link">studio@example.com ↗</a>
      </section>

      <footer className="ed-footer"><span>ÉDITIONS 27 — V2 PROBE</span><span>ENGINEERING SHARED / ART DIRECTION LOCAL</span></footer>
    </main>
  );
}
