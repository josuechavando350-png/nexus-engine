import { plan } from "./experience";
const chapters=[
  {n:"01",title:"Arrival",copy:"A threshold before explanation."},
  {n:"02",title:"The room",copy:"Space becomes the proof, not a card describing the space."},
  {n:"03",title:"After dark",copy:"The same identity survives when motion is reduced to still composition."}
] as const;
export default function Page(){return <main id="main-content" className="ci-shell" data-recipe={plan.recipeId}>
  <header className="ci-rail"><a href="#arrival" className="ci-mark">NOCTURNE</a><nav aria-label="Chapters">{chapters.map(c=><a key={c.n} href={`#c-${c.n}`}>{c.n}</a>)}</nav><a href="#reserve" className="ci-reserve">Reserve ↗</a></header>
  <section id="arrival" className="ci-arrival"><div className="ci-frame" aria-hidden="true"><div className="ci-orbit"/><div className="ci-horizon"/></div><p className="ci-caption">NEXUS V2 / media-immersion / synthetic visual field</p><h1>Enter after the city disappears.</h1><span className="ci-scroll">SCROLL / 01—03</span></section>
  {chapters.map((c,i)=><section className={`ci-chapter ci-chapter-${i+1}`} id={`c-${c.n}`} key={c.n}><span className="ci-chapter-no">{c.n}</span><div className="ci-visual" aria-hidden="true"><span>{c.title}</span></div><div className="ci-copy"><h2>{c.title}</h2><p>{c.copy}</p></div></section>)}
  <section id="reserve" className="ci-final"><p>40° 45′ / NIGHT WINDOW</p><h2>A table, a room, a time.</h2><a href="mailto:reserve@example.com">reserve@example.com <span>↗</span></a></section>
  <footer className="ci-footer"><span>NOCTURNE — V2 PROBE</span><span>MEDIA MAY DEGRADE / IDENTITY MUST NOT</span></footer>
</main>}
