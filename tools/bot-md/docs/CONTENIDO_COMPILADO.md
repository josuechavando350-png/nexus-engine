# Contenido compilado — Bot MD 0.6.0

`materialize` sustituye valores explícitos antes de servir la página. El mismo cambio puede aplicarse a HTML inicial, cadenas de JavaScript, JSON/JSON-LD y respuestas de navegación React Flight. No utiliza el runtime de sustitución posterior ni publica un mapa con los valores `expected` originales.

```bash
npm run bot-md -- materialize --site runs/copia-base --replacements sustituciones.json --assets mis-medios --out runs/contenido-compilado
npm run bot-md -- serve --site runs/contenido-compilado
```

Plan mínimo:

```json
{
  "schemaVersion": 1,
  "replacements": [
    { "id": "marca", "from": "Marca anterior", "to": "Mi marca" }
  ],
  "forbiddenTerms": ["Marca anterior"]
}
```

Las reglas coinciden con valores completos, respetan mayúsculas y se aplican globalmente en todas las rutas. `surfaces` permite limitar una regla a `html`, `javascript`, `json` o `flight`. Dos reglas con el mismo origen en la misma superficie se rechazan: no se elige una por azar. Cambiar un valor compartido en una sola ruta requiere separar el componente o sus datos, no aplicar una sustitución global contradictoria.

El comando recibe la reconstrucción base, nunca una plantilla con el runtime anterior. Mantiene CSS, fuentes, referencias React, identificadores, nombres de propiedades y rutas de módulos. El plan queda como archivo de trabajo; solo se copian recursos registrados, y el servidor no publica informes ni mapas de origen. Modifica `to` y recompila en una carpeta nueva.

## Datos de React

El lector no ejecuta Flight. Reescribe valores JSON y registros de texto `T`, calcula su longitud en bytes UTF-8 y conserva las referencias `$`. Reúne los bloques inline antes de procesarlos y vuelve a dividirlos sin partir pares sustitutos Unicode. Las cadenas nuevas se escapan para que `</script>` sea contenido y no cierre un script.

El encuadre se contrastó con [ReactFlightClient.js de React 19.0.0](https://github.com/react/react/blob/v19.0.0/packages/react-client/src/ReactFlightClient.js). Esta es una implementación limitada al formato textual observado: un registro binario, etiqueta desconocida, trama incompleta o UTF-8 inválido detiene la exportación. No se anuncia compatibilidad con todas las versiones de React ni con otros protocolos.

## Geometrías SVG propias

El plan puede añadir `svgPaths` con reglas `{ "id": "marca", "from": "M0 0L20 20", "to": "M 0 20 L 20 0" }`. En HTML solo se modifica el atributo `d` de elementos SVG `path`. En JavaScript, JSON y Flight se sustituyen las cadenas completas declaradas, incluidos arreglos de trazos y registros de texto, porque los componentes pueden construir `d` desde esos datos. La coincidencia es global: si el mismo trazo aparece en dos gráficos, se cambia en ambos.

La geometría nueva acepta comandos explícitos `M L H V C S Q T A Z`, también en minúsculas, con argumentos finitos; los arcos requieren radios no negativos y flags separados. Las repeticiones implícitas de argumentos deben expandirse. Las rutas calculadas en tiempo de ejecución, las imágenes y los SVG externos requieren otro tratamiento. No se interpreta el significado visual de un trazo ni se identifica automáticamente qué firma pertenece a quién.

`svgCounts` registra las coincidencias y `unmatchedSVGPaths` las reglas pendientes. El exportador no inyecta un parche de DOM ni un mapa público de geometrías originales. La sintaxis válida no prueba un resultado visual correcto: hay que comprobar la forma en navegador y el movimiento que depende de ella. [Caso real y límites](GRAFICOS_Y_COBERTURA.md).

## Resultado y límites

`materialization.json` registra las sustituciones por superficie, archivos modificados, hashes, reglas sin coincidencias y términos de origen todavía presentes. `blocked` produce código de salida 2; `materialized` significa que las reglas encontraron coincidencias y la búsqueda literal declarada no encontró restos. **No es aprobación de fidelidad ni certificación de limpieza semántica.**

La búsqueda incluye los SVG propios añadidos; no interpreta texto dentro de imágenes, vídeos, trazados vectoriales o datos binarios. Conserva código de comportamiento del sitio. No recupera automáticamente componentes React originales ni verifica cada ruta/estado que no se haya capturado. La comparación visual se hace con contenido idéntico; después de cambiarlo se comprueba la adaptación del diseño y de las interacciones.

Una exportación con error de análisis o integridad no recibe `routes.json`, por lo que no queda una copia parcial que el servidor pueda abrir. No se modifica la captura sellada.

## Prueba real de 0.5.0

El plan [materialized-replacements.json](../validation/daksh/materialized-replacements.json) contiene 23 reglas revisadas. Sustituye los 19 campos declarados de la portada y las referencias literales de identidad detectadas en las siete rutas. Incluye metadatos, JSON-LD, correo de contacto y texto de carga. Los nombres y contenidos de los proyectos de la referencia siguen pendientes; el plan no pretende cubrirlos.

La validación ejecutable [materialized-adaptation.mjs](../validation/daksh/materialized-adaptation.mjs) verifica HTML sin JavaScript, hidratación, menú móvil, adaptación geométrica del hilo, scroll, apertura de los seis proyectos, regreso, historial y recarga. La prueba de igualdad del hilo conserva los textos originales deliberadamente para aislar el efecto del compilador; no confunde una adaptación con identidad de píxeles.

## Ajuste de títulos al contenido nuevo

`fitText` es opcional y explícito. Mantiene las líneas y sus elementos, mide sus límites visibles y reduce la tipografía solamente cuando el texto no cabe. Recupera el tamaño definido por CSS al ampliar el espacio. No baja del mínimo indicado: si sigue recortado, informa `clipped`.

```json
{
  "fitText": [
    {
      "id": "hero-lines",
      "route": "/",
      "selector": "#hero-title",
      "lineSelector": ".hero-line",
      "minFontSizePx": 32
    }
  ]
}
```

Este fragmento se añade al plan completo. El runtime de ajuste necesita JavaScript; no sustituye texto ni reconstruye el DOM. Expone resultados en `window.__BOT_MD_LAYOUT__` y emite `bot-md:layout-updated` al cambiar el tamaño. La geometría del hilo se vuelve a calcular mediante los observadores del frontend conservado.

Una captura móvil reveló que `scrollWidth === innerWidth` no detectaba un título recortado por un contenedor. Se añadió una medición de los rangos de texto contra los límites visibles. La validación exige tanto el contenido correcto como ausencia de recorte; no basta el resultado del runtime de ajuste.

## Reproducir la ampliación de navegación

```bash
node validation/daksh/record-navigation.mjs runs/navegacion.json
node validation/daksh/complete-navigation.mjs runs/captura runs/navegacion.json runs/captura-navegacion
npm run bot-md -- build --capture runs/captura-navegacion --out runs/base-navegacion
npm run bot-md -- materialize --site runs/base-navegacion --replacements validation/daksh/materialized-replacements.json --assets validation/daksh/media --out runs/compilada
node validation/daksh/materialized-adaptation.mjs runs/base-navegacion runs/compilada validation/daksh/branding-content.json runs/adaptacion.json
```

El primer comando visita los seis proyectos desde la portada pública y registra únicamente solicitudes GET y cabeceras de enrutamiento. El segundo conserva intacta la captura anterior y descarga las variantes observadas que falten, sin quitar parámetros ni inventar respuestas. Hace falta acceso de red a la referencia. Las pruebas posteriores usan la copia local.

Para reconstruir la traza de igualdad del compilador sin sustituciones:

```bash
python validation/daksh/unpack-traces.py runs/originales
python validation/daksh/unpack-traces.py runs/compilador evidence/daksh/materialized-0.5.0
npm run bot-md -- compare-motion --reference runs/originales/motion-source-a --repeat-reference runs/originales/motion-source-b --candidate runs/compilador/motion-noop --out runs/comparacion
```

## Solicitudes que aparecen al probar la copia

La prueba de adaptación incluye `missingRequestLog` con las solicitudes RSC GET que devolvieron 404 en la copia y sus cabeceras de enrutamiento. Extrae ese objeto a un archivo y ejecuta:

```bash
npm run bot-md -- complete-requests --capture runs/captura-navegacion --requests runs/faltantes.json --out runs/captura-completada
```

El comando valida el origen, el método, las rutas y las cabeceras; consulta cada URL exacta en el origen y solo incorpora respuestas HTTP exitosas con el tipo esperado. La captura anterior permanece sellada e intacta. No convierte un 404 local en una respuesta aprobada ni elimina `_rsc` para fingir equivalencia entre variantes. Registra solicitudes pendientes y devuelve código 2 si no se resolvieron. Es necesario reconstruir, materializar y repetir el recorrido después de ampliar la captura.
