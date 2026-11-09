# Evidencia y límites — 2026-11-09

## Comprobación local inicial

Entorno disponible inicialmente: Node v22.16.0 en Linux. El repositorio declara Node 24; no se confunden ambos entornos.

- `node --check scripts/web-experience.mjs`: correcto.
- `node --test tests/web-experience.contract.mjs`: 26 pruebas, 26 aprobadas, 0 fallidas, 0 omitidas.
- `node scripts/web-experience.mjs list`: devuelve exactamente los cuatro recursos y sus commits.
- Las pruebas de registro usan índices Git temporales reales con gitlinks; las pruebas de estado usan un checkout local de prueba.
- La comprobación offline de argumentos de descarga usa un doble de Git, no una descarga real.
- Los commits y archivos de licencia del catálogo se consultaron mediante el conector GitHub.

## Descarga real verificada en GitHub Actions

Revisión comprobada: `ed1f947316587c2688464ec96cc54e26f4d62794`.

- Workflow: `NEXUS Web Experience Sources`.
- Run: https://github.com/josuechavando350-png/nexus-engine/actions/runs/42648388239
- Job: `129267764097`, `Pinned upstream source verification`.
- Entorno: Node 24, Ubuntu 24.04.
- Resultado observado: `success`, completado el 2026-11-09 a las 15:49:04 UTC.
- Las 26 pruebas offline pasaron.
- Los cuatro repositorios se descargaron realmente mediante `init all`.
- `verify all --checkout` comprobó commits completos, limpieza e identidad Git de cada archivo LICENSE.
- Repetir `init all` y la verificación estricta no produjo cambios en el checkout ni en el índice del repositorio principal.

Esto demuestra disponibilidad reproducible de las fuentes fijadas. No instala dependencias npm ni ejecuta demos, scripts upstream o adaptadores visuales.

## Compatibilidad con el monorepo

En `Build Verification`, run `42648388198`, job `129267764110`, el paso `Typecheck` pasó en Node 24 tras tipar explícitamente un mock de fetch ya existente en la prueba de atribución de Cano. Esa corrección no modifica runtime ni assertions.

La ejecución posterior de tests reportó 1.848 aprobadas, dos omitidas por la configuración existente y una fallida: el wrapper de este kit esperaba TAP, pero Node 24 emitió el reporter legible `spec`. Las 26 pruebas invocadas por el wrapper sí habían pasado. La corrección fija explícitamente `--test-reporter=tap`, conserva la comprobación de cero fallos y debe validarse en los checks del nuevo commit.

Los resultados anteriores pertenecen a los SHA y runs indicados, no certifican automáticamente commits posteriores. Consultar los checks del PR #757 para el estado más reciente. Este documento no declara toda la CI en verde ni autoriza despliegues.

## Fuera de esta validación

- Integración visual o instalación de paquetes de estas cuatro fuentes en una aplicación consumidora.
- Certificación del código upstream, accesibilidad visual, rendimiento móvil, lifecycle o comportamiento WebGL.
- Resolución de la discrepancia MIT/ISC de Scroll Rig; la identidad del archivo de licencia no constituye una autorización comercial global.

El cambio incorpora fuentes opcionales recuperables y verificables. No equivale a cuatro funcionalidades visuales activas en producción.
