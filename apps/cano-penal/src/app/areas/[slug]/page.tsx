import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "../../SiteChrome";
import { areas } from "../../content";

const areaMap = Object.fromEntries(areas.map(([name, href]) => [href.split("/").pop()!, name]));

const areaContent: Record<string, readonly string[]> = {
  "delitos-fiscales-y-financieros": [
    "Las investigaciones por delitos fiscales no empiezan con una detención. Empiezan mucho antes, con auditorías, requerimientos y cruces de información entre el SAT, la Unidad de Inteligencia Financiera y la Fiscalía. Cuando la persona se entera, la autoridad ya lleva meses armando el expediente.",
    "Esa es la diferencia que marca la defensa temprana. Trabajé dentro de la Procuraduría Fiscal de la Federación y dirigí el área de investigaciones de delitos fiscales y financieros. Conozco cómo se construye una carpeta de este tipo desde adentro: qué se busca, qué pesa y en qué momento se toman las decisiones.",
    "Atiendo defraudación fiscal, comprobantes que amparan operaciones inexistentes, contrabando, operaciones con recursos de procedencia ilícita y responsabilidad de representantes legales y contadores.",
    "Si le llegó una invitación, un requerimiento o un citatorio en materia fiscal, ese es el momento de asesorarse. No cuando ya hay una imputación."
  ],
  "delitos-patrimoniales-y-fraude": [
    "El fraude es de los delitos que más se denuncian y también de los que más se usan para presionar en conflictos que en el fondo son civiles o mercantiles. Una deuda no pagada, un negocio que salió mal o una sociedad que se rompió terminan convertidos en una carpeta penal.",
    "Por eso lo primero es distinguir qué tipo de asunto es realmente. En muchos casos la defensa consiste en demostrar que los hechos no encuadran en un delito, sino en un incumplimiento que se resuelve por otra vía.",
    "Atiendo fraude en sus distintas modalidades, abuso de confianza, administración fraudulenta, robo y daño en propiedad ajena, tanto en defensa como en representación de quien resultó afectado."
  ],
  "homicidio-y-delitos-violentos": [
    "Son los asuntos donde las primeras horas pesan más. Lo que se dice, lo que se firma y lo que se deja de hacer al inicio queda en el expediente y acompaña el proceso hasta el final.",
    "En estos casos la defensa se construye sobre la prueba: la cadena de custodia, los dictámenes periciales, la mecánica de los hechos y la consistencia de los testimonios. Cada uno de esos puntos se revisa a detalle, porque es ahí donde suelen estar las debilidades de la acusación.",
    "Atiendo homicidio en sus distintas modalidades, lesiones, portación de armas y delitos cometidos con violencia. Asumo la representación en diligencias y audiencias de manera personal.",
    "Si detuvieron a un familiar, el momento de llamar es ahora, no mañana."
  ],
  "delitos-sexuales": [
    "Son procesos delicados en los que se juegan la libertad y la reputación de una persona, y donde la exposición pública puede hacer tanto daño como el proceso mismo.",
    "El trabajo aquí exige rigor y discreción a partes iguales: revisar la prueba con detenimiento, cuidar los tiempos procesales y manejar el asunto con la reserva que el caso requiere.",
    "Atiendo la defensa en investigaciones y procesos por delitos de esta naturaleza, así como la representación de víctimas que buscan acompañamiento durante el procedimiento.",
    "Todo lo que se conversa está protegido por el secreto profesional."
  ],
  "corrupcion-y-administracion-publica": [
    "Un servidor público puede verse señalado por una decisión tomada en el ejercicio de sus funciones, por una firma en un expediente o por hechos ocurridos en un área que dirigía. Y un particular puede quedar involucrado por haber contratado con el gobierno.",
    "Estos asuntos suelen mezclar responsabilidad administrativa y penal al mismo tiempo, con la Auditoría Superior, los órganos internos de control y la Fiscalía actuando en paralelo. Entender esa mecánica es parte del trabajo.",
    "Atiendo peculado, ejercicio indebido del servicio público, uso ilícito de atribuciones, cohecho, enriquecimiento ilícito y las responsabilidades derivadas de la contratación pública."
  ],
  "despojo-y-defensa-de-victimas": [
    "No todos los que llegan a un despacho penal están acusados. Muchos son quienes resintieron el delito y no saben cómo hacer valer sus derechos.",
    "Ser víctima no significa esperar a que la autoridad actúe por su cuenta. La ley reconoce a la víctima como parte en el proceso: puede aportar pruebas, impugnar determinaciones y exigir la reparación del daño. Ejercer esos derechos requiere asesoría.",
    "Atiendo despojo y recuperación de inmuebles, representación de víctimas en investigaciones y procesos, coadyuvancia con la Fiscalía, impugnación del no ejercicio de la acción penal y reclamo de la reparación del daño."
  ],
  "justicia-penal-para-adolescentes": [
    "Cuando el señalado es un adolescente, el procedimiento es distinto. Existe un sistema integral propio, con reglas, plazos y consecuencias que no son las del sistema para adultos, y con un principio que lo rige todo: la reintegración social y familiar.",
    "Las decisiones que se toman al inicio pueden definir si el asunto se resuelve por una salida alterna o si avanza a juicio. Ese es el punto donde la asesoría cambia el resultado.",
    "Atiendo la defensa de adolescentes en investigaciones y procesos, la búsqueda de soluciones alternas y el acompañamiento a la familia durante el procedimiento."
  ],
  "amparo-recursos-y-apelaciones": [
    "Una resolución adversa no siempre es el final. El sistema prevé vías para revisarla: la apelación, el amparo indirecto contra actos dentro del proceso y el amparo directo contra la sentencia.",
    "Estas vías tienen plazos breves y requisitos técnicos estrictos. Un recurso mal planteado o presentado fuera de tiempo cierra la puerta de manera definitiva, y por eso conviene revisarlo cuanto antes.",
    "Atiendo apelación contra autos y sentencias, amparo indirecto contra actos de autoridad dentro del procedimiento, amparo directo contra sentencias definitivas y reconocimiento de inocencia.",
    "Si recibió una resolución que le fue adversa, el tiempo corre desde la notificación."
  ]
};

export function generateStaticParams() {
  return Object.keys(areaMap).map(slug => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const name = areaMap[slug];
  const paragraphs = areaContent[slug];
  if (!name || !paragraphs) return {};
  const fiscal = slug === "delitos-fiscales-y-financieros";
  return {
    title: `${name} — ${fiscal ? "abogado delitos fiscales CDMX" : "abogado penalista CDMX"}`,
    description: paragraphs[0]
  };
}

export default async function AreaPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const name = areaMap[slug];
  const paragraphs = areaContent[slug];
  if (!name || !paragraphs) notFound();

  return (
    <PageShell>
      <section className="cp-page">
        <div className="cp-wrap cp-page-copy">
          <div className="cp-eyebrow">Área de práctica</div>
          <h1 className="cp-page-title">{name}</h1>
          <div className="cp-copy" style={{ marginTop: "2.5rem" }}>
            {paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
          </div>
        </div>
      </section>
    </PageShell>
  );
}
