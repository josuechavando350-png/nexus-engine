# EXPRESSIVENESS.md — reference-alfil

## DESIGN INTENT

Salón de belleza y spa. Sensación buscada: elegancia, aire, precisión,
delicadeza, sensación editorial. Dependencia de cards deliberadamente
muy baja. Se descartó explícitamente el cliché serif+dorado+negro+
bordes-redondeados: sin dorado (acento arcilla/rosa apagado), sin ningún
radius en toda la composición. Dirección elegida: split editorial
asimétrico en el hero (sin foto dominante), servicios como lista
numerada (no grid de 6 cajas), CTA primario como link subrayado (sin
chrome de botón) y CTA secundario como rectángulo con borde recto,
motion lento y delicado.

Diseñado sin mirar Mesón ni Nexus Bot.

## CORE PRIMITIVES USED

`Container`, `Cluster`, `Link`.

## CORE PRIMITIVES REJECTED

- `Grid` — mismo motivo que en Mesón: el split del hero es asimétrico
  (`7fr 5fr`), `Grid` solo permite columnas iguales.
- `Stack` — el ritmo vertical de esta Experience se resolvió con
  `padding`/`gap` propios de cada bloque, no con un `gap` uniforme entre
  hermanos; no encajó de forma natural.
- `Section`, `Box`, `Button`, `VisuallyHidden` — mismos motivos que en
  reference-meson (ver ese EXPRESSIVENESS.md).

## CLIENT-SPECIFIC CSS

`theme.ts` (paleta sin dorado, radius en cero), `styles.css` (~210
líneas: hero editorial, lista de servicios, subrayado animado),
`a11y.css` (tercera repetición del mismo hueco de Core).

## WRAPPERS CREATED

Ninguno.

## WORKAROUNDS

Dos ajustes de posición resueltos con `style={{ ... }}` inline en
`page.tsx` en vez de una clase dedicada: la posición del caption de la
foto de muestra (`marginTop: "-2.5rem"`) y el espaciado del botón de
cierre. Son parches puntuales, no una solución limpia — se registran
como deuda menor, no se "arreglaron" retroactivamente con una clase
nueva porque el problema real es que esta composición tiene layouts de
una sola vez (no repetidos), y crear una clase para un solo uso no
habría sido mejor.

## OVERRIDES

Ninguno. Sin `!important`.

## FRICTION POINTS

1. Mismo hueco de skip-link/focus-visible de Core (tercera vez).
2. `Grid` sin soporte de proporciones asimétricas (segunda vez, ver
   reference-meson).
3. **Nuevo, específico de esta Experience**: el esquema `StyleFingerprintV0`
   asume un solo lenguaje de CTA por página. Alfil tiene deliberadamente
   dos (link subrayado + rectángulo outline) — no hay forma limpia de
   describir ambos en un solo bloque `cta`. Documentado en
   `style-fingerprint.json` como limitación, no resuelto aquí.

## MISSING CAPABILITIES

Ninguna que debiera vivir en Core. La lista numerada de servicios y el
subrayado animado son dirección artística de esta Experience.

## POTENTIAL ABSTRACTIONS (evidencia, no implementadas)

- Skip-link/focus-visible (ver FRICTION POINTS #1).
- Reset base casi idéntico al de las otras dos probes y el seed.

## NO INVENTAR DATOS DE CLIENTES

Alfil es un salón de belleza y spa real (Azcapotzalco, CDMX). Las
categorías de servicio (Corte, Color, Tratamiento facial, Spa) son
genéricas e ilustrativas, marcadas como "Categoría de muestra" en el
propio código — no son el catálogo real de servicios ni precios.

## PERFORMANCE

Sin dependencias nuevas. Sin `"use client"` — toda la interacción
(subrayado animado, indent-on-hover) es CSS puro.

## ACCESSIBILITY

Landmarks, skip-link, `:focus-visible`, `prefers-reduced-motion`
respetado (transiciones del link/lista se desactivan), placeholder de
media con `role="img"` + `aria-label` honesto.

## SECURITY

Mismo baseline de headers que el seed y las otras dos probes.
