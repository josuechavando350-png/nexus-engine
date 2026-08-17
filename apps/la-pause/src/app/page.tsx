import Image from "next/image";
import { plan } from "./experience";

const phoneDisplay = "55 5658 6891";
const phoneHref = "tel:+525556586891";
const menuHref = "https://lapause.mx/menu/";
const reserveHref = "https://lapause.mx/";
const mapsHref = "https://www.google.com/maps/search/?api=1&query=Av.%20Francisco%20Sosa%20287%2C%20Santa%20Catarina%2C%20Coyoac%C3%A1n%2C%2004010%20CDMX";

const courseImages = [
  { src: "/media/threshold.webp", alt: "Rótulo de LA PAUSE pintado sobre el muro blanco de la casona." },
  { src: "/media/molcajete.webp", alt: "Platillo servido en molcajete con salsa roja y tiras de tortilla." },
  { src: "/media/hojaldre.webp", alt: "Chile hojaldrado servido con mole y crema." },
  { src: "/media/patio.webp", alt: "Patio de LA PAUSE con mesas, sombrillas rojas y vegetación." },
  { src: "/media/enfrijoladas.webp", alt: "Enfrijoladas con chorizo, queso y jalapeño." },
  { src: "/media/enchiladas.webp", alt: "Enchiladas verdes cubiertas con crema y queso." }
] as const;

export default function HomePage() {
  const [arrival, chapters, conversion] = plan.narrativeSequence;

  return (
    <main id="main-content">
      <div className="table-tabs" aria-label="Acciones principales">
        <a href={menuHref}>Menú</a>
        <a href={reserveHref}>Reservar</a>
        <a href={mapsHref}>Llegar</a>
      </div>

      <section className="threshold" data-stage={arrival?.stageId} aria-labelledby="threshold-title">
        <div className="threshold-copy">
          <p className="kicker">Francisco Sosa · Coyoacán</p>
          <h1 id="threshold-title"><span>LA</span> PAUSE</h1>
          <p className="threshold-line">Cruzas la puerta. La ciudad baja de volumen. Empieza la mesa.</p>
          <a className="text-action" href={menuHref}>Ver qué se sirve hoy</a>
        </div>
        <figure className="threshold-frame">
          <Image src={courseImages[0].src} alt={courseImages[0].alt} width={405} height={900} priority sizes="(max-width: 760px) 88vw, 38vw" />
          <figcaption>Av. Francisco Sosa 287</figcaption>
        </figure>
      </section>

      <div className="runner" aria-hidden="true"><span>una pausa · una mesa · una sobremesa</span></div>

      <section className="table-journey" data-stage={chapters?.stageId} aria-labelledby="journey-title">
        <header className="table-heading">
          <p className="kicker">No es una galería. Es la mesa avanzando.</p>
          <h2 id="journey-title">De la primera cucharada a la sobremesa.</h2>
        </header>

        <article className="place-setting place-setting--red">
          <div className="plate plate--one">
            <Image src={courseImages[1].src} alt={courseImages[1].alt} width={405} height={900} sizes="(max-width: 760px) 82vw, 30vw" />
          </div>
          <div className="annotation">
            <span className="meal-time">Desayuno</span>
            <h3>Caliente, directo, sin ceremonia de más.</h3>
            <p>Chilaquiles, enchiladas, huevos, café. El comienzo tiene salsa y pan en la mesa.</p>
          </div>
        </article>

        <article className="place-setting place-setting--mole">
          <div className="annotation annotation--left">
            <span className="meal-time">Comida</span>
            <h3>El plato ocupa el centro; el patio hace lo demás.</h3>
            <p>La cocina se mueve entre lo mexicano y lo internacional, con platos para quedarse un rato más.</p>
            <a className="text-action" href={menuHref}>Consultar menú completo</a>
          </div>
          <div className="plate plate--two">
            <Image src={courseImages[2].src} alt={courseImages[2].alt} width={405} height={900} sizes="(max-width: 760px) 82vw, 30vw" />
          </div>
        </article>

        <article className="patio-breath">
          <Image src={courseImages[3].src} alt={courseImages[3].alt} width={405} height={900} sizes="(max-width: 760px) 100vw, 44vw" />
          <div className="patio-copy">
            <p className="kicker">La pausa literal</p>
            <h3>Mesa bajo sombrilla. Luz entre árboles. Coyoacán alrededor.</h3>
            <p>Exterior o interior: la experiencia cambia de ritmo, no de dirección.</p>
          </div>
        </article>

        <div className="two-courses" aria-label="Dos platos de la mesa">
          <figure>
            <Image src={courseImages[4].src} alt={courseImages[4].alt} width={405} height={900} sizes="(max-width: 760px) 78vw, 24vw" />
            <figcaption>Un plato que llega con carácter.</figcaption>
          </figure>
          <p className="between-courses">y después,<br />otra razón<br />para quedarse.</p>
          <figure>
            <Image src={courseImages[5].src} alt={courseImages[5].alt} width={405} height={900} sizes="(max-width: 760px) 78vw, 24vw" />
            <figcaption>La mesa sigue, no se reinicia.</figcaption>
          </figure>
        </div>
      </section>

      <section className="take-a-seat" data-stage={conversion?.stageId} aria-labelledby="seat-title">
        <div className="seat-circle">
          <p className="kicker">Tu lugar en la mesa</p>
          <h2 id="seat-title">Haz la pausa.</h2>
          <a className="reserve-action" href={reserveHref}>Reservar mesa</a>
        </div>
        <address className="arrival-note">
          <strong>LA PAUSE</strong><br />
          Av. Francisco Sosa 287<br />
          Santa Catarina, Coyoacán<br />
          04010 CDMX
          <div className="arrival-links">
            <a href={mapsHref}>Abrir ubicación</a>
            <a href={phoneHref}>{phoneDisplay}</a>
          </div>
        </address>
      </section>

      <footer className="closing-mark">
        <span>LA PAUSE</span>
        <p>Desayunos · comidas · patio · sobremesa</p>
      </footer>
    </main>
  );
}
