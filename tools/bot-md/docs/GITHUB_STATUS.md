# Estado de incorporación a Nexus Engine

Bot MD 0.4.0 se conserva como herramienta independiente en `tools/bot-md`. No modifica los paquetes Core/Experience, el runtime Rust ni aplicaciones de clientes. No forma parte de los patrones actuales del workspace pnpm. Usa su propio `package-lock.json`.

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
