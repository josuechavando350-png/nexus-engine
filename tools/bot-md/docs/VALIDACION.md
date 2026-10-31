# Validación histórica 0.1.0 — 31 de octubre de 2026

> Documento histórico de la entrega 0.2.0. Las referencias a copias preconstruidas o Markdown incluidos corresponden al ZIP de esa entrega. Esta edición GitHub incluye código, configuraciones y evidencia; esos recursos se regeneran al ejecutar el bot.
> Este documento conserva la prueba inicial. La validación pública posterior de la versión 0.2.0 está en [DAKSH_VALIDACION.md](DAKSH_VALIDACION.md).

## Entorno observado

- Node.js 24.22.1, Linux x64.
- Playwright 1.62.1.
- Chromium 138.0.7204.0 mediante `CHROMIUM_EXECUTABLE_PATH`.
- La descarga del navegador predeterminado de Playwright falló en este entorno. Se utilizó un Chromium alternativo obtenido del paquete `@sparticuz/chromium@138.0.2`. El binario no se incluye en el ZIP.
- La captura externa de `https://example.com/` falló por `getaddrinfo EAI_AGAIN`. No se verificó una web pública ni se atribuye ese intento a una reconstrucción aprobada.

## Demo funcional

Sitio de prueba propio con dos páginas, CSS externo e importado, SVG, JavaScript, datos obtenidos de una API GET, pestañas, acordeón y menú móvil.

| Parámetro                                    | Resultado observado                                |
| -------------------------------------------- | -------------------------------------------------- |
| Viewports                                    | 390 × 844, 820 × 1000 y 1440 × 900                 |
| Páginas                                      | 2                                                  |
| Estados capturados                           | 13                                                 |
| Recursos capturados                          | 8                                                  |
| Origen durante reconstrucción y verificación | Apagado                                            |
| Estados aprobados                            | 13/13                                              |
| Diferencia visual detectada                  | 0 en los 13 estados, con los umbrales documentados |
| Incidencias de captura en esta demo          | 0                                                  |

Esto demuestra funcionamiento en el sitio de prueba y en los estados medidos. No demuestra un porcentaje de éxito sobre sitios arbitrarios. Las imágenes se comparan con umbral perceptual 0.1 y antialiasing excluido; no se afirma igualdad binaria de los PNG.

## Pruebas automatizadas

Siete pruebas aprobadas, cero fallidas y cero omitidas. El flujo de integración utiliza siete estados entre escritorio y móvil:

| Caso                                          | Resultado                                  |
| --------------------------------------------- | ------------------------------------------ |
| Reconstrucción inicial, con origen apagado    | 7/7 estados aprobados                      |
| Defecto deliberado: tamaño de fuente alterado | 7/7 estados rechazados                     |
| Reparación CSS con comparación antes/después  | 7/7 estados aprobados de nuevo             |
| Eliminación deliberada de la respuesta de API | 7/7 estados rechazados                     |
| Modificación de una referencia tras sellarla  | Alteración detectada y operación rechazada |

Las otras seis pruebas cubren validación de configuración, destinos de red/rutas de archivos, reescritura CSS, reescritura JavaScript mediante AST, reescritura HTML y comparación de imágenes con defectos o dimensiones distintas.

También se completó `npm run typecheck`. La suite completa terminó en aproximadamente 42 segundos en este entorno. La velocidad no constituye una garantía para otras máquinas ni sitios.

## Evidencia incluida

En `evidence/` se incluyen el registro de pruebas, el recibo de integración, el resultado de verificación de la demo y el registro de reparación. Las capturas de navegador se regeneran al ejecutar `npm run demo`; no están incluidas en el paquete.

`examples/reconstructed-site/` incluye la reconstrucción de la demo propia y se puede servir sin iniciar el sitio original:

```bash
npm run replica -- serve --site examples/reconstructed-site --port 4173
```

## Pendientes comprobables

- Probar sitios públicos reales cuando exista acceso de red y se seleccione una URL objetivo.
- Medir compatibilidad con frameworks, recursos dinámicos y sitios con mayor complejidad.
- Medir calidad de cualquier generador de componentes futuro; esta entrega no incluye uno.
- Añadir cobertura de navegadores, animaciones y estados que esta versión declara fuera de alcance.

## Documentación técnica de referencia

- [Chrome DevTools Protocol: DOMSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/)
- [Chrome DevTools Protocol: CSS](https://chromedevtools.github.io/devtools-protocol/tot/CSS/)
- [Playwright: Network](https://playwright.dev/docs/network)
- [Playwright: Visual comparisons](https://playwright.dev/docs/test-snapshots)
- [Playwright: Mock APIs](https://playwright.dev/docs/mock)
