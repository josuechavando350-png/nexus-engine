# Estado de incorporación a Nexus Engine

Bot MD 0.7.0 se conserva como herramienta independiente en `tools/bot-md`. No modifica los paquetes Core/Experience, el runtime Rust ni aplicaciones de clientes. No forma parte de los patrones actuales del workspace pnpm. Usa su propio `package-lock.json`.

La versión 0.2.1 cambia el nombre público y añade el comando `npm run bot-md`; conserva `npm run replica` como alias compatible. Las rutas internas de capturas anteriores no cambian.

La evidencia de 0.2.0 es histórica: 12 pruebas del motor; Daksh, 45/47 estados en la pasada completa y 2/2 en la repetición dirigida. No se afirma certificación universal.

Esta rama es una incorporación pendiente de integración. Los comandos globales `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` y el job `validate` de Nexus Engine deben aprobar antes de declarar la integración completa. No se han ejecutado para esta rama ni se afirma que estén aprobados.

## Validación local de Bot MD 0.2.1

- Instalación limpia con `npm ci --ignore-scripts --offline`: aprobada.
- `npm run typecheck`: aprobado.
- `npm run bot-md -- --help`: muestra Bot MD 0.2.1.
- `npm test`: 12 pruebas aprobadas, cero fallidas. Incluye captura, reconstrucción, verificación, detección de defectos, reparación y preservación del entorno de entrada.
- La captura del sitio de prueba generó Markdown no vacío por estado; `examples/sample-content.md` conserva una muestra real de esa ejecución.

Los registros de esta versión están en `evidence/tests-0.2.1.log` y `evidence/integration-receipt-0.2.1.json`. Las pruebas locales del módulo no sustituyen los checks globales pendientes del monorepo.

## Versión 0.3.0

Añade exportación de estilos, catálogo y plantilla con texto editable, captura/comparación de SVG con movimiento activo y ampliación de recursos observados durante el scroll. Las pruebas de esta entrega y sus límites están en [EXPERIENCIA.md](EXPERIENCIA.md).

La rama continúa separada de main; siguen pendientes las verificaciones globales del monorepo.

Validación 0.3.0: 17 pruebas aprobadas, cero fallidas; compilación, typecheck y formato aprobados. Daksh: adaptación de seis campos aprobada en móvil/escritorio; comparación temporal marcada como inestable.

## Versión 0.4.0

Reloj controlado y preparación completa del hilo: 48 muestras original/copia aprobadas; repetición del origen también aprobada, con la tolerancia de 2 px intacta. Las tres trazas completas están archivadas y verificadas por hash. Se amplió el catálogo a metadatos, medios y enlaces y se corrigió la ruta de las páginas visitadas mediante interacciones. La plantilla permite medios propios y dispone de auditoría de contenido servido.

19 pruebas del módulo aprobadas, cero fallidas. La adaptación de 19 campos aprobó en escritorio/móvil. La eliminación completa de información original continúa pendiente: la auditoría de la demostración detecta 31 archivos con términos del origen. Ver [CONTROL_Y_CONTENIDO.md](CONTROL_Y_CONTENIDO.md).

Los checks globales y la integración a main continúan pendientes.

## Versión 0.5.0

Añade materialización de contenido en HTML, JavaScript, JSON/JSON-LD y Flight antes de servir la copia. El plan revisado contiene 23 sustituciones; no se publica el mapa con los valores originales. El ajuste opcional de títulos detecta recortes ocultos por overflow y conserva elementos anidados.

26 pruebas del módulo aprobadas. La prueba de control del compilador, con contenido idéntico, mantiene aprobadas las 48 muestras SVG y la repetición del origen. La portada y los seis proyectos pasaron el recorrido de ida/regreso, historial y recarga en escritorio y móvil, sin errores de JavaScript ni HTTP. Se comprobaron 19 campos de la portada y cero recorte visible del título. Los resultados de adaptación y navegación están en `evidence/daksh/materialized-0.5.0/` y el estado explícito en `COMPLETION.json`.

Siguen pendientes el reemplazo completo de textos y gráficos de los proyectos, componentes propios y los checks globales de Nexus. El término `materialized` describe la operación aplicada y la búsqueda literal declarada; no significa que la eliminación de toda información ni la integración estén completas.

## Versión 0.6.0

Añade reglas de geometría SVG que se materializan en HTML y datos de JavaScript/JSON/Flight. Se reemplazan las dos firmas declaradas por gráficos propios, sin introducir un parche del DOM. La demostración pasa a 140 reglas de texto y 11 trazos; 231 campos del catálogo se comprueban en navegador. El resto del catálogo y otros gráficos continúan pendientes de revisión.

28 pruebas del módulo aprobadas. La adaptación aprobó 56 escenarios de las siete rutas en 1440×900 y 390×844, incluyendo recarga de cada proyecto y navegación de regreso, con cero errores JavaScript/HTTP. Se comprobó avance y regreso del hilo. El compilador también reproduce byte a byte los 91 archivos de la copia sin cambios de 0.5 y los 115 de su adaptación, conservando esa evidencia histórica sin atribuir igualdad visual a textos nuevos.

Una solicitud GET de Orbit detectada al recargar se completó desde el origen y se repitió la validación; se conserva el informe anterior que detectó el 404. Evidencia y pendientes: `evidence/daksh/materialized-0.6.0/` y `COMPLETION.json`.

Los checks globales de Nexus y la integración a main siguen pendientes. En el commit padre `c313f925b9c06b3161262b5eee7f32fa3a5ba240` solo se observó el check `Vercel Preview Comments`; ese check no equivale a `validate` ni a pruebas del monorepo. No se utiliza como aprobación del código de Bot MD.

## Versión 0.7.0

Añade `extract-detail` para seleccionar un trazo SVG y generar un paquete independiente con geometría, estilos, controlador propio y Markdown. El ejemplo `exports/scroll-thread/` conserva variantes observadas en móvil y escritorio; no contiene el frontend ni la información de la página original. El controlador se puede montar en otros contenedores, modificar y desmontar sin borrar su contenido.

La validación del ejemplo comprobó 66 puntos de la geometría y 14 posiciones de scroll, movimiento reducido, seguimiento del extremo, variantes por ancho del contenedor y desmontaje. No hubo errores JavaScript/HTTP ni solicitudes al origen. La comparación geométrica no implica igualdad del tiempo, easing o todos los píxeles del efecto original; se usa un controlador nuevo.

También se añade el hash de `repairs.css` al construir y se actualiza al completar una reparación medida, para que el exportador pueda comprobar su integridad. Los checks globales de Nexus y la integración siguen pendientes. La web de Nexus Bot Studio no se ha modificado ni desplegado. El estado completo permanece en `in-progress`.
