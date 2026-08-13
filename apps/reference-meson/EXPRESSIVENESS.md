# EXPRESSIVENESS.md — reference-meson

## DESIGN INTENT

Restaurante mexicano (tacos, parrilla, alitas, hamburguesas, antojos —
categorías reales conocidas). Sensación buscada: material, caliente,
gastronómica, fotográfica, táctil, humana, expresiva. Premium sin ser
"parque temático" ni "plantilla de restaurante premium". Se descartó
deliberadamente el cliché del sitio productivo (fondo negro + naranja +
cards redondeadas + hero gigante + botones pill) a favor de: superficie
oscura cálida (no negro puro), acento terracota quemada, tipografía
expresiva de gran tamaño, composición en capas asimétrica (texto y
media se superponen ligeramente), menú como lista editorial de ritmo
irregular (no grid de cards), CTA "sellado" con sombra desplazada,
motion físico (press/lift).

Diseñado sin mirar Alfil ni Nexus Bot.

## CORE PRIMITIVES USED

`Container`, `Cluster`, `Stack`, `Link`.

## CORE PRIMITIVES REJECTED

- `Grid` — el hero necesita columnas `7fr 5fr` (asimétricas). `Grid` solo
  ofrece `columns` con `repeat(n, minmax(0,1fr))`, es decir columnas
  siempre iguales. No hay forma de pedirle una proporción asimétrica.
- `Section` — solo añade `paddingBlock` desde un `SpaceRole`. El ritmo
  vertical aquí es deliberadamente irregular (`clamp()` variable +
  excepción cada tercera fila del menú vía `nth-child(3n)`), no un valor
  de token fijo. Usar `Section` habría sido un wrapper vacío.
- `Box` — no hubo necesidad real de padding/margin aislado que Box
  resolviera mejor que un `div` con clase propia.
- `Button` — ninguna acción es un botón real; todas navegan a anclas
  (`#menu`, `#contacto`). `Link` es el primitive correcto, no `Button`.
- `VisuallyHidden` — no hubo contenido visualmente truncado que
  necesitara texto oculto adicional; los placeholders de media ya usan
  `aria-label` directo.

## CLIENT-SPECIFIC CSS

`theme.ts` (paleta completa), `styles.css` (~230 líneas de composición:
hero en capas, menú editorial, CTA sellado), `a11y.css` (skip-link +
focus-visible — ver FRICTION POINTS).

## WRAPPERS CREATED

Ninguno.

## WORKAROUNDS

Ninguno significativo.

## OVERRIDES

Ninguno. No hubo necesidad de `!important` ni de pelear contra un
default de Core — Core no impone ninguno.

## FRICTION POINTS

1. Mismo hueco de Core ya documentado en Fase 1: no existe un
   `SKIP_LINK_CSS`/regla `:focus-visible` exportado como string. Tuve que
   escribirlo a mano otra vez (segunda vez, contando el seed).
2. `Grid` no soporta proporciones asimétricas (`7fr 5fr`) — ver arriba.

## MISSING CAPABILITIES

Ninguna que debiera vivir en Core. Fila de menú indexada, capas
superpuestas, CTA con sombra desplazada: todo esto es dirección
artística de esta Experience, no infraestructura — correctamente NO
está en Core.

## POTENTIAL ABSTRACTIONS (evidencia, no implementadas)

- El bloque skip-link/focus-visible (ver FRICTION POINTS #1).
- El reset base (`box-sizing`, reset de `body`/`button`/`img`) es casi
  idéntico al del seed — ver reporte de diversidad para la comparación
  entre las tres probes.

## NO INVENTAR DATOS DE CLIENTES

Categorías de menú (tacos, parrilla, alitas, hamburguesas, antojos) son
reales y conocidas. Nombres de platillos específicos, descripciones y
cualquier cifra son contenido de demostración, etiquetado como tal en
el propio código (`"Categoría de muestra —..."`) y en la imagen
placeholder (`aria-label="...placeholder, no es una foto real..."`).

## PERFORMANCE

Sin dependencias nuevas. Sin JS de cliente (no hay `"use client"` en
este probe — toda la interacción es CSS `:hover`/`:active`/
`:focus-visible`, cero JavaScript de interacción). Media es un gradiente
CSS, no un asset de imagen.

## ACCESSIBILITY

Landmarks (`header`/`main`/`footer`/`nav[aria-label]`), skip-link,
`:focus-visible` visible, `prefers-reduced-motion` respetado (transición
del CTA se desactiva), placeholders de media con `role="img"` +
`aria-label` describiendo que son de muestra.

## SECURITY

Mismo baseline (`NEXUS_SECURITY_HEADERS_BASE`) que el seed y las otras
dos probes, sin reducir ningún control.
