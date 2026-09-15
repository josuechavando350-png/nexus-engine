export type HighIntentLanding = Readonly<{
  slug: string;
  eyebrow: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  intro: readonly string[];
  firstBlock: Readonly<{ title: string; body: string }>;
  secondBlock: Readonly<{ title: string; body: string }>;
  checkpoints: readonly Readonly<{ title: string; body: string }>[];
  whatsappText: string;
  relatedHref: string;
  relatedLabel: string;
}>;

export const highIntentLandings = Object.freeze([
  Object.freeze({
    slug: "orden-de-aprehension",
    eyebrow: "Defensa penal urgente",
    title: "Orden de aprehensión",
    metaTitle: "Orden de aprehensión en CDMX — defensa penal",
    metaDescription: "Defensa penal ante una orden de aprehensión en CDMX. Revisión inmediata de la situación, estrategia y atención personal por Eduardo Cano.",
    intro: Object.freeze([
      "Cuando existe o se sospecha una orden de aprehensión, actuar con información importa. Antes de tomar decisiones conviene ubicar con precisión qué autoridad interviene, en qué etapa está el asunto y qué actos procesales ya existen.",
      "La estrategia depende de los hechos y del expediente. La prioridad es evitar improvisaciones, revisar la situación jurídica completa y definir la defensa con base en información verificable."
    ]),
    firstBlock: Object.freeze({
      title: "Qué importa al inicio",
      body: "Identificar la autoridad, el origen de la investigación, el momento procesal y los actos que ya fueron emitidos permite decidir qué debe hacerse primero y qué no debe hacerse sin revisión previa."
    }),
    secondBlock: Object.freeze({
      title: "Defensa personal",
      body: "Eduardo Cano diseña directamente la estrategia y asume personalmente la representación en diligencias y audiencias. No se delega el análisis central del caso."
    }),
    checkpoints: Object.freeze([
      Object.freeze({ title: "Revisión inmediata", body: "La situación se analiza desde el estado procesal real del asunto, no desde suposiciones." }),
      Object.freeze({ title: "Actos de autoridad", body: "Se revisan las resoluciones y actuaciones relevantes para definir las vías de defensa disponibles." }),
      Object.freeze({ title: "Amparo y recursos", body: "Cuando corresponda, se valoran los medios de impugnación dentro de sus plazos y requisitos." }),
      Object.freeze({ title: "Acompañamiento", body: "La estrategia se explica de forma directa para que sepas qué está ocurriendo y cuáles son los siguientes pasos." })
    ]),
    whatsappText: "Hola licenciado, necesito asesoría por una posible orden de aprehensión.",
    relatedHref: "/areas/amparo-recursos-y-apelaciones",
    relatedLabel: "Conocer amparo, recursos y apelaciones"
  }),
  Object.freeze({
    slug: "carpeta-de-investigacion",
    eyebrow: "Defensa desde el inicio",
    title: "Carpeta de investigación",
    metaTitle: "Carpeta de investigación en CDMX — defensa penal",
    metaDescription: "Asesoría y defensa penal desde la carpeta de investigación en CDMX. Análisis temprano, atención personal y estrategia de defensa.",
    intro: Object.freeze([
      "Una carpeta de investigación se construye antes de que exista un juicio. En esa etapa se integran entrevistas, documentos, peritajes y otros datos que pueden definir el rumbo del asunto.",
      "La defensa temprana permite entender qué está investigando la autoridad, revisar cómo se está formando el expediente y preparar la estrategia antes de que las decisiones importantes ya estén tomadas."
    ]),
    firstBlock: Object.freeze({
      title: "Antes de la primera audiencia",
      body: "Lo que se declara, se entrega o se deja pasar durante la investigación puede acompañar el proceso después. Por eso la revisión inicial debe ser ordenada y estratégica."
    }),
    secondBlock: Object.freeze({
      title: "Experiencia desde dentro",
      body: "Eduardo Cano inició su carrera dentro de la Procuraduría Fiscal de la Federación y dirigió investigaciones de delitos fiscales y financieros. Esa experiencia permite leer la lógica con la que una autoridad construye un expediente."
    }),
    checkpoints: Object.freeze([
      Object.freeze({ title: "Origen del asunto", body: "Se identifica por qué comenzó la investigación y qué autoridad está interviniendo." }),
      Object.freeze({ title: "Datos de prueba", body: "Se revisa qué elementos existen y cuáles requieren análisis adicional o contraste." }),
      Object.freeze({ title: "Riesgos procesales", body: "Se ubican las decisiones que pueden modificar la posición jurídica de la persona investigada." }),
      Object.freeze({ title: "Estrategia temprana", body: "Se define una ruta de defensa antes de llegar a una audiencia sin preparación." })
    ]),
    whatsappText: "Hola licenciado, necesito asesoría por una carpeta de investigación.",
    relatedHref: "/#areas",
    relatedLabel: "Revisar áreas de práctica"
  }),
  Object.freeze({
    slug: "audiencias-penales",
    eyebrow: "Defensa en sala",
    title: "Audiencias penales",
    metaTitle: "Audiencias penales en CDMX — abogado penalista",
    metaDescription: "Defensa y representación en audiencias penales en CDMX. Preparación del caso, estrategia y atención personal por Eduardo Cano.",
    intro: Object.freeze([
      "Las audiencias concentran decisiones que pueden cambiar el rumbo de un proceso penal. Llegar preparado exige conocer el expediente, anticipar los puntos de discusión y tener una estrategia clara para ese momento concreto.",
      "La representación no se limita a estar presente. Cada audiencia debe responder a una estrategia general del caso y a lo que realmente está ocurriendo en el expediente."
    ]),
    firstBlock: Object.freeze({
      title: "Preparación antes de entrar a sala",
      body: "La audiencia se trabaja desde antes: revisión del expediente, definición del objetivo procesal y preparación de los argumentos que deben sostenerse frente a la autoridad."
    }),
    secondBlock: Object.freeze({
      title: "Representación directa",
      body: "Eduardo Cano asume personalmente la representación en diligencias y audiencias y mantiene comunicación directa con la persona que confía su caso al despacho."
    }),
    checkpoints: Object.freeze([
      Object.freeze({ title: "Expediente", body: "La audiencia se prepara a partir de lo que realmente consta en el asunto." }),
      Object.freeze({ title: "Objetivo procesal", body: "Cada comparecencia debe tener un propósito claro dentro de la estrategia general." }),
      Object.freeze({ title: "Argumentación", body: "Los puntos centrales se ordenan y priorizan antes de la audiencia." }),
      Object.freeze({ title: "Seguimiento", body: "Después de cada actuación se revisa qué cambió y cuáles son los siguientes pasos." })
    ]),
    whatsappText: "Hola licenciado, necesito asesoría para una audiencia penal.",
    relatedHref: "/casos",
    relatedLabel: "Conocer casos representativos"
  }),
  Object.freeze({
    slug: "defensa-penal-inmediata",
    eyebrow: "Atención urgente",
    title: "Defensa penal inmediata",
    metaTitle: "Defensa penal inmediata en CDMX — abogado penalista",
    metaDescription: "Atención penal inmediata en CDMX ante detenciones, citatorios y situaciones urgentes. Defensa personal y estrategia desde las primeras horas.",
    intro: Object.freeze([
      "En una detención, un citatorio o una situación penal urgente, las primeras horas pesan. Lo que se dice, se firma o se deja de hacer puede quedar incorporado al expediente y acompañar el proceso después.",
      "La prioridad es entender qué ocurrió, qué autoridad interviene y cuál es la situación jurídica real antes de tomar decisiones apresuradas."
    ]),
    firstBlock: Object.freeze({
      title: "Cuando el tiempo sí importa",
      body: "La defensa comienza por ordenar la información disponible, identificar la autoridad y ubicar el momento procesal para actuar con una estrategia concreta."
    }),
    secondBlock: Object.freeze({
      title: "Contacto directo",
      body: "No hay intermediarios para el análisis central del caso. Eduardo Cano mantiene comunicación directa y diseña personalmente la estrategia de defensa."
    }),
    checkpoints: Object.freeze([
      Object.freeze({ title: "Detenciones", body: "Se revisa la situación jurídica y el contexto inmediato para definir la respuesta de defensa." }),
      Object.freeze({ title: "Citatorios", body: "Antes de comparecer conviene entender el motivo, la autoridad y el alcance de la diligencia." }),
      Object.freeze({ title: "Primeras actuaciones", body: "Se cuida qué información se entrega y qué decisiones requieren revisión previa." }),
      Object.freeze({ title: "Siguiente paso", body: "La estrategia se explica con claridad para evitar decisiones tomadas por presión o desinformación." })
    ]),
    whatsappText: "Hola licenciado, necesito defensa penal inmediata.",
    relatedHref: "/areas/homicidio-y-delitos-violentos",
    relatedLabel: "Conocer defensa en asuntos urgentes"
  })
] satisfies readonly HighIntentLanding[]);

export function getHighIntentLanding(slug: string): HighIntentLanding | null {
  return highIntentLandings.find((landing) => landing.slug === slug) ?? null;
}
