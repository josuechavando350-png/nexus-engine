# Gráficos y cobertura — Bot MD 0.6.0

Esta entrega amplía la sustitución de contenido y permite reemplazar geometrías SVG declaradas. Continúa en desarrollo: no certifica la eliminación de toda información original, una réplica universal ni la integración de Nexus.

## Qué se cambió

El plan de demostración contiene 140 reglas de texto y 11 trazos. Los diez trazos del cargador dibujan una marca propia `BOT MD`; el trazo de la firma pequeña se cambia por un monograma `BM`. Se conservan las clases, los elementos y los controladores de animación. La línea naranja que sigue el scroll se comprueba por separado.

Los seis casos reciben nombres `DEMO01` a `DEMO06`, introducciones, metadatos, encabezados y 55 párrafos largos de texto provisional. Es contenido de demostración sobre el trabajo de Bot MD; no presenta los proyectos o resultados del autor como proyectos de Nexus. Sigue habiendo textos, diagramas y datos de ejemplo de la referencia fuera de estas reglas. Las rutas técnicas `/work/eigna`, etc., se conservan en esta fase para mantener la navegación capturada.

El catálogo contiene 1.784 campos. El plan corresponde a 231 campos observados. Los otros 1.553 quedan como pendientes de revisión o sustitución; incluyen también enlaces y etiquetas genéricas. **Estos números no son un porcentaje de fidelidad ni un recuento de datos personales restantes.** Los gráficos necesitan además una revisión visual independiente.

## Evidencia

Los archivos se encuentran en `evidence/daksh/materialized-0.6.0/`:

- `adaptation.json`: campos exactos en las siete páginas, con y sin JavaScript, navegación a los seis proyectos, recarga de cada proyecto, regreso a portada e historial. Chromium en 1440×900 y 390×844 con entrada táctil emulada; 56 escenarios registrados.
- `materialization.json`: coincidencias por formato, recursos realmente exportados y hashes. Los once trazos originales declarados no aparecen en los archivos servidos ni en los DOM comprobados.
- `coverage.json`: correspondencia con el catálogo y campos pendientes. Es inventario, no aprobación visual.
- `regression.json`: reproducción byte a byte de los 91 archivos servidos por la copia sin cambios de contenido de 0.5 y de los 115 archivos de su adaptación. Permite mantener como evidencia histórica las 48 muestras temporales y las pruebas de aquella versión; no atribuye equivalencia temporal al diseño con nuevos textos.
- `missing-requests.json` y `request-completion.json`: una variante GET de navegación de Orbit, observada al recargar, se obtiene con sus parámetros y cabeceras exactos. El recorrido anterior con 404 se conserva en `earlier-navigation-failure.json`.
- Capturas de la portada, del primer proyecto y de la marca propia. Son muestras visuales de esos estados, no capturas de todas las posibles interacciones.

La prueba nueva de scroll comprueba avance y regreso del trazo. No compara cada frame contra la referencia, pues cambiar la longitud del texto modifica la disposición y la geometría. La equivalencia temporal histórica de 48 muestras usa contenido idéntico deliberadamente.

## Reproducir

Con una captura completa y su reconstrucción base:

```bash
npm run build
node validation/daksh/prepare-demo.mjs runs/catalogo/content.json runs/base runs/plan-demo.json runs/cobertura.json
npm run bot-md -- materialize --site runs/base --replacements runs/plan-demo.json --assets validation/daksh/media --out runs/demo
node validation/daksh/demo-adaptation.mjs runs/demo runs/cobertura.json runs/plan-demo.json runs/validacion
```

`prepare-demo.mjs` es una configuración del caso Daksh, no un generador universal de textos. `materialized-demo-replacements.json` conserva el plan concreto editable. Para otro sitio hay que revisar y declarar sus propias reglas. El informe de adaptación devuelve código 2 si falla un campo, un trazo, el desplazamiento, el recorte del título hidratado, la navegación o una respuesta HTTP. Las solicitudes RSC faltantes se registran en `missingRequestLog`; pueden completarse con `complete-requests` y requieren una reconstrucción y prueba nuevas.

## Pendientes

Falta revisar y sustituir el resto del contenido y los elementos gráficos de los ejemplos, construir una salida completa en componentes propios, ampliar estados y navegadores y aprobar los checks globales de Nexus del commit exacto. El frontend entregado por la referencia sigue formando parte de la copia. `COMPLETION.json` permanece en `in-progress`.
