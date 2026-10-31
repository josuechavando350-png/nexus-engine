# Daksh: validación de Nexus Replica 0.2.0

> Documento histórico de la entrega 0.2.0. Las referencias a copias preconstruidas o Markdown incluidos corresponden al ZIP de esa entrega. Esta edición GitHub incluye código, configuraciones y resultados de verificación. Los manifiestos completos y las copias preconstruidas pertenecen al ZIP histórico; los recursos se regeneran al ejecutar el bot.
> Fuente: https://dakshgajjar.com/ · 31 de octubre de 2026.

**Resultado documentado: 45/47 estados aprobados en el barrido completo y 2/2 en una repetición dirigida. Los 47 estados tienen una verificación aprobada; se conservan los dos fallos de la primera pasada.**

La copia local y los Markdown están incluidos. El código del frontend fue conservado y adaptado para resolver sus recursos localmente. No se recuperó el repositorio original ni se generó una nueva aplicación React.

## Abrir la copia

Desde la carpeta del proyecto:

```bash
npm ci
npm run replica -- serve --site examples/daksh-reconstructed --port 4173
```

Abrir http://127.0.0.1:4173/. Esta copia puede servirse sin Chromium y sin acceso al sitio original. Node.js 22 o superior es necesario. La instalación inicial requiere acceso a npm.

## Cobertura medida

| Medida                                              | Resultado                         |
| --------------------------------------------------- | --------------------------------- |
| Páginas                                             | 7                                 |
| Tamaños                                             | 1440 × 900, 820 × 1000, 390 × 844 |
| Estados capturados                                  | 47                                |
| Recursos GET observados inicialmente                | 67                                |
| Dependencias CSS adicionales                        | 21                                |
| URLs de recursos disponibles en la copia            | 88                                |
| Estados fallidos durante captura                    | 0                                 |
| Cargas fallidas / estados truncados                 | 0 / 0                             |
| Integridad de referencias                           | Comprobada por SHA-256            |
| Mayor diferencia de píxeles detectada en el barrido | 0, con los umbrales definidos     |
| Errores de geometría/texto en ese barrido           | 0                                 |
| Solicitudes ausentes / errores JavaScript           | 0 / 0                             |
| Comprobación completa                               | 45 pass, 2 fail                   |
| Repetición de los dos estados pendientes            | 2 pass, 0 fail                    |

| Ruta             | Estados |
| ---------------- | ------- |
| /                | 17      |
| /work/eigna      | 5       |
| /work/orbit      | 5       |
| /work/mealops    | 5       |
| /work/papertrail | 5       |
| /work/scribe     | 5       |
| /work/crediflow  | 5       |

La portada incluye estado inicial, región US, apertura/cierre de contacto, navegación a Eigna y menús en tablet/móvil. Los proyectos incluyen estado inicial y menús donde existen. El formulario de contacto no se envió.

Los 47 Markdown están en `examples/daksh-markdown/`; `index.json` relaciona cada archivo con su URL, tamaño y escenario. No se consideran 47 páginas diferentes.

## Correcciones comprobadas

1. Transporte mediante el proxy del entorno y confianza explícita de su certificado.
2. Espera de la señal real de preparación de la portada: `.hero[data-hero-entrance=complete]`.
3. Conservación de encabezados Next.js que controlan las respuestas RSC y las precargas.
4. Preservación de `crossorigin` y descarga de dependencias CSS que faltaban al navegar entre proyectos.
5. Obtención de 34 respuestas RSC como bytes HTTP: 19 cuerpos difirieron de la representación textual de CDP. Se contrastaron caracteres alterados con la respuesta original; no se corrigieron mediante sustituciones adivinadas. Los hashes anteriores y nuevos permanecen en `rawResponseRefresh`.
6. Corrección del cambio involuntario de hover/pointer al desconectar la sesión CDP usada para inspeccionar DOM/fuentes. La prueba mínima está en `evidence/daksh/input-environment-repro.json` y la suite comprueba que las nuevas capturas mantienen estas condiciones entre escenarios.
7. Tiempo de lectura de aserciones vinculado al tiempo de navegación configurado, con registro explícito de excepciones y selección de estados para comprobaciones parciales.

## Cómo se comparó la captura histórica

Las capturas originales permanecieron intactas. Su primera inspección CDP cambiaba hover/pointer antes del estado `s1`; la siguiente captura full-page restauraba esas señales. Se reprodujo explícitamente ese comportamiento con `--legacy-cdp-replay` para comparar bajo las mismas condiciones. El informe registra esta opción. Las capturas nuevas mantienen la sesión de inspección hasta cerrar el contexto y registran las condiciones de entrada en `layout.input`.

El barrido completo se ejecutó con cuatro estados concurrentes. En `p0-mobile-s5` (menú de portada) y `p2-tablet-s1` (menú de Orbit), una comprobación de atributo devolvió falso aunque el layout medido registraba el valor esperado; píxeles, geometría, red y JavaScript coincidieron. Ambos pasaron en la repetición secuencial, usando el tiempo de lectura configurado y registrando excepciones. Esta repetición no elimina los fallos previos ni demuestra ausencia universal de problemas de temporización.

Se mantienen los umbrales originales: `pixelThreshold=0.1`, `maxDiffRatio=0.005`, `geometryTolerance=1`. Pixelmatch excluye antialiasing. Cero diferencias detectadas no significa igualdad binaria de imágenes. No se enmascararon regiones ni se editaron referencias para conseguir aprobación.

## Evidencia y reproducción

- `evidence/daksh/full-verification.json`: los 47 resultados del barrido completo.
- `evidence/daksh/recheck-verification.json`: comprobación explícita de los dos estados pendientes.
- `evidence/daksh/assessment.json`: índice del resultado utilizado por estado, conservando ambas pasadas.
- `evidence/daksh/original-manifest.json` y `completed-manifest.json`: configuración, estados, procedencia y hashes.
- `evidence/tests-0.2.0.log`: pruebas automatizadas del motor.
- `evidence/integration-receipt-0.2.0.json`: detección de defectos, reparación, API ausente y alteración de referencias.

Los manifiestos incluidos son evidencia documental; las capturas gráficas no se incluyen. Para generar un conjunto completo y un informe visual nuevo:

```bash
npm run browsers
npm run replica -- run --config validation/daksh/full-config.json --out runs/daksh-nuevo
```

El contenido y los resultados pueden cambiar si cambia la web original. En esta ejecución se usaron Node.js 24.22.1, Playwright 1.62.1 y Chromium 138.0.7204.0. El binario alternativo de Chromium no se incluye; la captura y su comparación requieren la misma versión de navegador.

## Alcance que no se certifica

La validación corresponde a estos estados, tamaños y Chromium. Solicita movimiento reducido y desactiva animaciones al tomar imágenes; no certifica toda la animación temporal. Los tamaños móviles no emulan todo el hardware de un teléfono. El sitio contiene un elemento de anuncio de ruta con shadow root, registrado como contenido complejo. No se verificaron todos los estados posibles de ese árbol ni de la aplicación.

Las respuestas GET son grabaciones. No hay backend reconstruido, procesamiento real de formularios, autenticación ni equivalencia funcional universal. No se publicó la copia en un dominio externo.
