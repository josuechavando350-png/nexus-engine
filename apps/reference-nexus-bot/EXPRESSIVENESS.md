# EXPRESSIVENESS.md — reference-nexus-bot

## DESIGN INTENT

Tecnología propia, ingeniería, sistemas, precisión. Se descartó
explícitamente el cliché SaaS-dark-mode-gradiente-cards-"AI-powered".
Dirección elegida: superficie neutra fría y clara (no dark mode), sin
gradientes, acento verde-azulado técnico (no azul/morado genérico),
composición estructural: hero con intro técnica + diagrama de líneas
(no hero gigante centrado), los cuatro productos reales de Nexus Bot
Studio (Nexus Web, Growth, Sales, Automation — información ya conocida,
no inventada) presentados en una grilla continua de bordes compartidos
(no cards flotantes con sombra), etiquetas monospace entre corchetes,
motion casi instantáneo (preciso, no rebote).

Diseñado sin mirar Mesón ni Alfil.

## CORE PRIMITIVES USED

`Container`, `Cluster`, `Link`, `VisuallyHidden` (agregado durante el
cierre de Fase 2 — ver FRICTION POINTS #5).

## CORE PRIMITIVES REJECTED

- `Grid` — la grilla de módulos necesita bordes compartidos y **cero**
  espacio entre celdas para leerse como una sola hoja técnica continua,
  no como objetos separados. `Grid.gap` solo acepta un `SpaceRole`
  (`space.xs`…`space.xl`); ningún rol representa "cero". No hay forma de
  pedirle a `Grid` un gap verdaderamente nulo.
- `Section`, `Box`, `Button` — mismos motivos que en las otras dos
  probes.

## CLIENT-SPECIFIC CSS

`theme.ts` (paleta fría, radius en cero), `styles.css` (~200 líneas:
grilla de bordes compartidos, diagrama de líneas, etiquetas monospace),
`a11y.css` (cuarta repetición del mismo hueco de Core, contando el
seed).

## WRAPPERS CREATED

Ninguno.

## WORKAROUNDS

Ninguno en el resultado final.

## OVERRIDES

Ninguno. Sin `!important`.

## FRICTION POINTS

1. Mismo hueco de skip-link/focus-visible de Core (cuarta vez).
2. `Grid.gap` sin opción de cero real (ver arriba) — distinto del
   problema de proporciones asimétricas que sí afectó a Mesón y Alfil;
   aquí las columnas SÍ son iguales (`repeat(2, 1fr)`, algo que `Grid`
   sí podría expresar), pero el gap forzado impidió usarlo igual.
3. **Error real cometido y corregido durante esta sesión**: la primera
   versión de `page.tsx` pasaba `paddingInline="0"` a `Container`, un
   valor inválido (`Container.paddingInline` espera un `SpaceRole` como
   `"space.md"`, no el literal `"0"`). Lo detecté al revisar el código
   manualmente (no hay `next`/`@types/react` instalados en este entorno
   para que un typecheck real lo atrapara) y lo corregí quitando la prop
   en vez de inventar un valor. Se documenta aquí en vez de ocultarlo.
4. **Igual que en reference-alfil**: dos lenguajes de CTA coexistentes
   (sólido + outline) no caben limpio en un solo bloque `cta` de
   `StyleFingerprintV0`.
5. **Segundo bug real encontrado durante el cierre de Fase 2**: la
   jerarquía de encabezados saltaba de `h1` directo a `h3` (los nombres
   de módulo), sin ningún `h2` intermedio — un defecto real de
   accesibilidad (lectores de pantalla navegando por encabezados verían
   un salto de nivel). Corregido agregando un `h2` visualmente oculto
   (`VisuallyHidden`) antes de la grilla de módulos, sin cambiar nada
   del diseño visual. Este fue precisamente el primer uso natural real
   de `VisuallyHidden` en las tres probes — inicialmente descartado por
   "no hubo necesidad", lo cual era cierto hasta que este bug apareció.

## MISSING CAPABILITIES

Ninguna que debiera vivir en Core. La grilla de bordes compartidos y las
etiquetas entre corchetes son dirección artística de esta Experience.

## POTENTIAL ABSTRACTIONS (evidencia, no implementadas)

- Skip-link/focus-visible (ver FRICTION POINTS #1) — con 4 ocurrencias
  independientes ya (seed + 3 probes), este es el candidato más fuerte
  de toda la Fase 2 para promoverse a Core.
- Reset base casi idéntico a las otras dos probes y el seed.
- Posible mejora a `Grid`: aceptar un gap explícito de "ninguno", no
  solo roles de `SpaceRole`. Señalado, no implementado.

## NO INVENTAR DATOS DE CLIENTES

Los cuatro módulos (Nexus Web, Nexus Growth, Nexus Sales, Nexus
Automation) son las líneas de producto reales y ya conocidas de Nexus
Bot Studio, no datos inventados. Las descripciones son deliberadamente
simples y no incluyen cifras, precios ni testimonios inexistentes.

## PERFORMANCE

Sin dependencias nuevas. Sin `"use client"`. El diagrama es HTML/CSS
puro (`aria-hidden`, decorativo), no una librería de diagramas.

## ACCESSIBILITY

Landmarks, skip-link, `:focus-visible`, `prefers-reduced-motion`
respetado, diagrama decorativo marcado `aria-hidden="true"` (su
contenido no aporta información que no esté ya en el texto visible).

## SECURITY

Mismo baseline de headers que el seed y las otras dos probes.
