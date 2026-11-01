# Detalle SVG independiente

Se extrajo únicamente el trazo seleccionado y sus estilos observados. El controlador de scroll es propio y editable, sin React, Next, GSAP ni código del sitio original. No se exportan textos, imágenes ni otros componentes.

## Integración

```js
import { mountScrollThread } from "./scroll-thread.js";
const definition = await (await fetch("./effect.json")).json();
const effect = mountScrollThread(document.querySelector("#mi-seccion"), definition, { start: .85, end: .25, smoothingMs: 100, headRadius: 4 });
// Al desmontar la sección:
// effect.destroy();
```

El contenedor necesita altura mayor que cero. Cambia `--bot-md-thread-color` y `--bot-md-thread-width` en su CSS. `effect.json` contiene trazos, colores, grosores y variantes por ancho del contenedor. `refresh()` recalcula después de desplazar una sección sin scroll/resize. `setOptions()` cambia el intervalo y suavizado. `destroy()` elimina listeners, observadores y el SVG. No elimina tus hijos ni sus listeners.

Con movimiento reducido se muestra la línea completa y no se anima con el scroll. El SVG es decorativo y no recibe foco ni intercepta clics.

## Alcance

Esto es una extracción de dibujo y estilos con un comportamiento propio. No reproduce automáticamente el tiempo, easing, recortes o efectos de profundidad de la referencia. La trayectoria mantiene su proporción dentro de la sección y no se adapta a la forma de nuevos títulos. Revisa `extraction.json`, que enumera dependencias visuales del origen no exportadas. La extracción no equivale a una aprobación: valida el paquete en tu composición final.
