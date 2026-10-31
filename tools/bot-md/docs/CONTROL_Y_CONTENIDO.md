# Bot MD 0.4.0: movimiento reproducible y sustitución de contenido

## Resultado

La comparación del hilo SVG de Daksh aprobó las 48 muestras configuradas entre el original y la copia local. La repetición independiente del original también aprobó. Se mantuvo la tolerancia de 2 píxeles y los 36 elementos SVG de cada muestra, incluidos los trazos vacíos; no se ocultaron elementos ni se ampliaron umbrales.

| Medida                          | Original/copia | Original/repetición |
| ------------------------------- | -------------: | ------------------: |
| Muestras completas              |          48/48 |               48/48 |
| Discrepancias fuera del umbral  |              0 |                   0 |
| Diferencia máxima de puntos     |    0,030151 px |         0,030151 px |
| Diferencia máxima de longitud   |    0,020508 px |         0,020508 px |
| Diferencia máxima de dashoffset |           0 px |                0 px |
| Incidencias de red/JavaScript   |              0 |                   0 |

La medición usa Chromium 138.0.7204.0, escritorio 1440 × 900 y móvil táctil 390 × 844, ocho posiciones de ida/regreso y muestras a 0/160/640 ms. No es una certificación de toda la web, de todos sus estados ni de cada frame.

## Causa y corrección

La señal anterior esperaba la entrada de las letras del hero. El código entregado por el sitio inicia después un dibujo del hilo que tarda aproximadamente tres segundos: la señal no representaba la preparación completa del trazo. El nuevo perfil espera `data-hero-thread-complete=true` y `data-signature-complete=true`.

Bot MD también incorpora `clockMode: controlled`. Instala el reloj antes de cargar la página, espera los recursos de inicio y una señal explícita, y avanza temporizadores y `requestAnimationFrame` de JavaScript en intervalos medidos. Cada muestra conserva su tiempo virtual real y la comparación rechaza muestras que se apartan del perfil. La animación sigue ejecutándose durante los avances; no se convierte el hilo en una imagen fija.

El modo de tiempo real permanece disponible. El reloj controlado no gobierna todos los relojes del navegador: vídeo, workers, WebGL y animaciones CSS del compositor requieren pruebas adicionales. La [documentación de Playwright](https://playwright.dev/docs/clock) describe las funciones controladas por su Clock API.

## Contenido editable

El catálogo incluye ahora enlaces, `src`, `srcset`, `poster` y metadatos de contenido, además del texto y las etiquetas accesibles. La plantilla puede registrar imágenes, audio y vídeo propios con `--assets`; valida rutas y evita cargar medios nuevos que no estén registrados. Los SVG aportados se restringen a contenido estático.

También se corrigió la ruta del catálogo: una interacción puede comenzar en `/` y terminar en `/work/eigna`. Se usa la URL del DOM observado, no la URL inicial del escenario. En Daksh el catálogo corregido contiene 1.784 campos en siete rutas; esta cifra sustituye el conteo anterior como catálogo vigente.

La demostración reemplaza 19 campos de la portada: título, descripciones, metadatos sociales, marca del encabezado, etiqueta accesible y los seis textos de la prueba anterior. La adaptación aprobó en ambos tamaños, con menú móvil funcional, hilo sensible al scroll, cero desbordamiento horizontal y sin campos ausentes/en conflicto. Las pruebas controladas también verifican carga de una imagen propia mediante `srcset` y cambio de enlaces.

Los metadatos se comprobaron en el DOM renderizado. La implementación actual puede conservar metadatos originales en el HTML inicial; todavía no certifica las tarjetas sociales para rastreadores sin JavaScript.

## Lo que continúa pendiente

La sustitución de campos no elimina automáticamente el texto de los bundles, las respuestas del framework o el mapa que contiene los valores `expected`. El nuevo comando `audit-content` revisa los bytes realmente servidos y genera `SUSTITUCION.md` más un informe por archivo/campo.

En la demostración detectó:

- 19 sustituciones declaradas y 1.765 campos sin sustitución declarada.
- 31 archivos servidos con coincidencias de los términos `Daksh`, `Gajjar` o `dakshgajjar.com`.
- 51 recursos originales de código, datos o medios que requieren revisión.

Por eso la auditoría informa `blocked`. Un campo pendiente puede ser una etiqueta genérica que se decida conservar; el conteo no equivale a 1.765 datos personales ni a 1.765 errores visuales. La auditoría no usa OCR ni comprensión semántica universal. Las revisiones explícitas por hash no silencian términos prohibidos.

Para cerrar la separación completa falta reconstruir los componentes y sus datos iniciales, eliminar las dependencias de contenido original y verificar el resultado. Esta entrega no presenta la plantilla como libre de toda información del sitio fuente.

## Evidencia íntegra y reproducción

Se conservan las tres trazas completas en archivos `.json.xz`, junto con sus hashes y los resultados. Se pueden verificar sin volver a consultar la web:

```bash
python validation/daksh/unpack-traces.py runs/restored-0.4
npm run bot-md -- compare-motion --reference runs/restored-0.4/motion-source-a --candidate runs/restored-0.4/motion-local-a --repeat-reference runs/restored-0.4/motion-source-b --out runs/restored-comparison
```

Para repetir la captura en vivo, usar `validation/daksh/controlled-motion-config.json`. Los hashes detectan cambios; no son una firma externa.

- [Comparación](../evidence/daksh/controlled-0.4.0/comparison.json)
- [Tramas completas y manifiesto](../evidence/daksh/controlled-0.4.0/)
- [Adaptación de los 19 campos](../evidence/daksh/controlled-0.4.0/adaptation.json)
- [Auditoría por archivo](../evidence/daksh/controlled-0.4.0/content-audit-summary.json)
- [MOVIMIENTO.md](daksh/MOVIMIENTO_0_4.md)
- [SUSTITUCION.md](daksh/SUSTITUCION_0_4.md)
- [Registro de pruebas](../evidence/tests-0.4.0.log)

Las 19 pruebas del motor aprobaron. Se conserva la evidencia histórica de 0.3.0; el nuevo perfil no borra las comparaciones anteriores. Los checks globales del monorepo y la integración a `main` continúan pendientes.
