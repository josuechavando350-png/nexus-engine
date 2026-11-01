# Detalles selectivos — Bot MD 0.7.0

El primer modo selectivo extrae **un trazo SVG decorativo** desde una reconstrucción local. Conserva sus datos geométricos y estilos observados en los tamaños declarados. Entrega un controlador propio que dibuja la línea con el scroll, muestra un punto en su extremo y un círculo al completarse. Se puede usar con texto y composición propios, sin importar el frontend completo de la referencia.

## Paquete editable

El ejemplo verificado está en `exports/scroll-thread/`. Sus seis recursos públicos son `index.html`, `demo.css`, `demo.js`, `scroll-thread.js`, `scroll-thread.css` y `effect.json`. `DETAIL.md` explica la integración. `extraction.json` conserva la evidencia de origen y `routes.json` permite abrir el paquete con el servidor local de Bot MD. Los informes no se publican por ese servidor.

```bash
cd tools/bot-md
npm ci
npm run bot-md -- serve --site exports/scroll-thread --port 4173
```

La demostración se abre en `http://127.0.0.1:4173`. Los seis archivos públicos también funcionan en un servidor estático normal. No requiere React, Next, GSAP ni servicios del origen. Abrir el HTML directamente mediante `file://` no sustituye un servidor HTTP para módulos y `fetch`.

## Selección y extracción

```bash
npm run bot-md -- capture --url https://sitio.example --out runs/captura
npm run bot-md -- build --capture runs/captura --out runs/base
npm run bot-md -- extract-detail --site runs/base --config detalle.json --out runs/detalle
```

La reconstrucción debe contener los recursos y estados necesarios para mostrar el detalle. La extracción valida los hashes de los archivos servidos. Si una reconstrucción antigua conserva `repairs.css` sin hash, hay que reconstruirla con esta versión. La captura sellada se mantiene intacta. Las reparaciones medidas actualizan ahora el hash de ese CSS.

Ejemplo de configuración:

```json
{
  "schemaVersion": 1,
  "kind": "scroll-svg",
  "route": "/",
  "selector": "#mi-trazo",
  "readySelector": "html[data-ready=true]",
  "viewports": [
    { "name": "mobile", "width": 390, "height": 844, "minWidth": 0 },
    { "name": "desktop", "width": 1440, "height": 900, "minWidth": 768 }
  ]
}
```

El selector debe encontrar exactamente un `path` con longitud positiva, sin relleno ni gradiente. La señal de preparación evita capturar una curva antes de que el sitio la construya. Se comprueba que el atributo `d` permanezca igual en dos posiciones de scroll; esto detecta algunos trazos dinámicos, no todas sus posibles variaciones. Los errores HTTP o JavaScript de la reconstrucción detienen la extracción. No se publica un manifiesto de una exportación incompleta.

`minWidth` define el cambio de variante según el **ancho del contenedor**, no el de la ventana. Los puntos de cambio son explícitos; no se infieren como reglas universales desde dos capturas.

## Integración

```js
import { mountScrollThread } from "./scroll-thread.js";
const definition = await (await fetch("./effect.json")).json();
const controller = mountScrollThread(miSeccion, definition, {
  start: 0.85,
  end: 0.25,
  smoothingMs: 100,
  headRadius: 4,
  endRingRadius: 12,
});
// Al desmontar la sección:
// controller.destroy();
```

`start` es la fracción de altura de la ventana que debe alcanzar el borde superior de la sección para empezar. `end` es la que debe alcanzar el borde inferior para terminar. Cambia el color y grosor con `--bot-md-thread-color` y `--bot-md-thread-width`. La línea conserva su proporción; no se deforma para rodear automáticamente nuevos títulos.

`refresh()` vuelve a medir la sección tras un cambio de posición sin scroll o resize. `setOptions()` actualiza el comportamiento. `destroy()` retira el SVG y sus listeners/observadores sin borrar el contenido del contenedor. Varias instancias pueden coexistir. El SVG es decorativo, no intercepta clics ni recibe foco. Con movimiento reducido se muestra el trazo completo y se detiene la animación asociada al desplazamiento.

## Validación guardada

`evidence/daksh/detail-0.7.0/report.json` corresponde al ejemplo exportado. Se verificó el trazo `capabilities-entry` de Daksh, en Chromium 390×844 con entrada táctil emulada y 1440×900:

- 33 puntos y la longitud del trazo por tamaño, comparados con la geometría observada en la referencia local.
- Siete posiciones por tamaño: inicio, 25 %, 50 %, 75 %, final y regreso. El punto sigue al extremo dibujado y el círculo aparece al completar el recorrido.
- Activación y desactivación de movimiento reducido, dos instancias, un contenedor de 320 px dentro de una ventana mayor y desmontaje que conserva su contenido.
- Cero solicitudes al sitio original; únicamente los seis recursos propios. Sin errores JavaScript ni HTTP en la demostración.

La prueba del módulo verifica además píxeles pintados antes y después del punto de progreso, cambios de variante al redimensionar, aislamiento del contenido y rechazo de entradas alteradas o selecciones ambiguas. Las pruebas del módulo no sustituyen las pruebas globales de Nexus.

## Límites del adaptador

El movimiento es una implementación nueva y configurable. No se afirma igualdad temporal con el controlador de origen. Máscaras, recortes, filtros, mezcla de colores y dependencias de elementos vecinos se registran para revisión; no se exportan. En el trazo de ejemplo no se observaron esas dependencias heredadas. Comparar geometría no certifica identidad de todos los píxeles pintados.

Siguen pendientes el selector visual, otros tipos de detalle, el ajuste de curvas a contenido nuevo y la validación dentro de la web definitiva de Nexus Bot Studio. El rediseño de esa web no se ha desplegado. Los pendientes de reconstrucción completa y de integración global continúan en `COMPLETION.json`.
