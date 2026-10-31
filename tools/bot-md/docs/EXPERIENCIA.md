# Bot MD 0.3.0: estilos, hilo y contenido editable

Esta entrega convierte la captura en un flujo para reutilizar la apariencia y el comportamiento observado con otros textos. El frontend conservado ejecuta la experiencia; los Markdown explican sus medidas y límites.

## Qué funciona

- `styles`: exporta `ESTILOS.md`, `estilos.json`, `tokens.css` y las hojas CSS externas capturadas. Conserva condiciones responsive, variables con su contexto, fuentes y keyframes.
- `motion`: registra curvas SVG, longitud, puntos, trazo, progreso y visibilidad con movimiento activo, durante scroll de ida y regreso. Genera `MOVIMIENTO.md`, `motion.json` y su sello SHA-256.
- `catalog`: descubre campos de texto y etiquetas accesibles a partir del DOM renderizado, identificando variantes entre estados.
- `template`: sustituye los campos elegidos, conserva elementos anidados y notifica el cambio de tamaño. Detecta selectores ambiguos, nodos ausentes y textos de origen distintos. Reaplica una sustitución si el frontend vuelve a renderizar el texto original.
- `enrich --trace`: incorpora recursos GET observados durante el movimiento sin eliminar parámetros de enrutamiento. Mantiene la referencia original y crea una captura derivada.
- `run --motion-config ... --content ...`: reúne captura, exportación de estilos, catálogo, reconstrucción, verificaciones y plantilla en una ejecución.

## Medición en Daksh

Fecha: 31 de octubre de 2026. Navegador: Chromium 138.0.7204.0.

| Comprobación                | Resultado observado                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------- |
| Extracción de estilos       | 47 estados, 36 propiedades computadas, 5 hojas CSS, 16 condiciones de media queries |
| Catálogo                    | 1.763 campos; 53 variantes entre estados señaladas para revisión                    |
| Movimiento                  | 48 muestras por ejecución: 2 tamaños × 8 posiciones de ida/regreso × 3 tiempos      |
| Pantallas                   | Escritorio 1440 × 900; móvil táctil 390 × 844                                       |
| Geometría SVG               | 36 elementos por muestra, incluidos trazos temporalmente vacíos                     |
| Red                         | 1 variante GET adicional detectada y capturada; 89 recursos en total                |
| Recursos anteriores         | Ningún contenido binario de los 88 recursos anteriores cambió                       |
| Copia final con movimiento  | 48 muestras; cero incidencias de red/JavaScript registradas                         |
| Adaptación de contenido     | 6 campos sustituidos; prueba aprobada en los 2 tamaños                              |
| Identidad temporal estricta | **Inestable; no aprobada**                                                          |

La prueba de adaptación cambió las tres líneas del título, la descripción inicial, el nombre y el rol. La descripción creció de 49,59 a 99,19 píxeles de alto en escritorio y de 36,66 a 73,31 en móvil. Cambió la geometría del hilo, se conservaron sus elementos y el progreso respondió al scroll. No hubo desbordamiento horizontal ni campos ausentes/en conflicto. La navegación de escritorio siguió visible y el menú móvil abrió y cerró.

El alto del bloque hero permaneció en 900/844 píxeles, respectivamente. La prueba demuestra adaptación a estos textos concretos; no demuestra que cualquier cantidad de texto quepa sin ajustar el diseño.

## Lo que todavía no está certificado

La comparación original/copia detectó 139 discrepancias de geometría, progreso o estilo por elemento/muestra con tolerancia de 2 píxeles. La comparación entre dos ejecuciones del propio original detectó 157. Son discrepancias, no un porcentaje de parecido ni una cuenta de páginas fallidas. Los máximos y cada detalle permanecen en el informe JSON.

Por eso la evaluación es `unstable`. No se aumentaron umbrales ni se ocultaron elementos para aprobarla. Falta sincronizar y validar las líneas temporales de animación de forma reproducible; estas mediciones no permiten atribuir toda la variación a la reconstrucción ni declarar igualdad en cada frame.

La sustitución visible de seis campos tampoco equivale a retirar toda la información original. El catálogo permite continuar la edición, pero imágenes, vídeos, cadenas en JavaScript, metadatos y respuestas conservadas necesitan revisión y sustitución. Esta entrega no promete una limpieza automática completa del contenido.

## Evidencia y reproducción

- [ESTILOS.md generado](daksh/ESTILOS.md)
- [MOVIMIENTO.md generado](daksh/MOVIMIENTO.md)
- [CONTENIDO.md generado](daksh/CONTENIDO.md)
- [Resumen y huellas de trazas](../evidence/daksh/experience/assessment.json)
- [Comparaciones completas](../evidence/daksh/experience/motion-comparison.json)
- [Medidas antes/después de editar](../evidence/daksh/experience/adaptation.json)
- [Configuración de movimiento](../validation/daksh/motion-config.json)
- [Textos de ejemplo](../validation/daksh/editable-content.json)

Los JSON de trazas completos y los recursos de la web se generan localmente mediante los comandos del README. El repositorio conserva configuración, código, informes, medidas y huellas; no incluye el paquete de la web capturada. Las huellas detectan cambios en archivos, no son una firma externa.

Para repetir la adaptación después de construir ambas variantes:

```bash
npm run build
node validation/daksh/adaptation.mjs RUTA_SITIO_ORIGINAL RUTA_PLANTILLA_EDITADA SALIDA_JSON
```

## Validación del motor

Las 17 pruebas aprobaron (cero fallidas); también aprobaron compilación, typecheck y formato. La suite cubre exportación de estilos, sustitución preservando elementos, conflictos y rerender, menú móvil, curvas que responden al texto, SVG vacíos, movimiento activo, integridad, variantes GET y el flujo CLI. También conserva las pruebas previas de reconstrucción, detección de defectos, reparación y aislamiento de red.

Ver [registro de pruebas](../evidence/tests-0.3.0.log). Los checks globales de Nexus Engine siguen pendientes; esta entrega permanece en la rama `bot-md`, sin integración a `main`.
