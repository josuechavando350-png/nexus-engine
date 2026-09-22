# Reproducción de importación en entorno aislado — Némesis v17

Este documento registra las comprobaciones realizadas en el entorno del asistente **antes** de subir el archivo al PR. No es una certificación de los 100 motores.

- Archivo: `GAUSS_NEMESIS_v19_fuente_para_subir_GitHub_NO_CERTIFICADO.zip`.
- SHA-256 fijado: `dfb28dd86060dc31edae1b930a208adabb1c66606e26da88a49790fdbf5884c6`.
- Importación en directorio vacío mediante `python3 gauss/nemesis/scripts/import-source.py`: **297 archivos aceptados**; `verify-source-lock.mjs` valida 100 fuentes, 31 pruebas, 130 ejemplos.
- `node gauss/nemesis/engine/scripts/smoke-100.mjs`: 100 resultados esperados, incluidos 99 positivos y un rechazo esperado. No prueba el alcance original de cada motor.
- `node --test --test-concurrency=4 gauss/nemesis/engine/test/*.test.mjs`: **401 pruebas: 397 PASS, 4 SKIP, 0 FAIL**, con Node 22.16.0. Los cuatro SKIP no deben contarse como verificación superada.
- Se descubrió que las pruebas alteran `engine/evidence/native-snark-95-verification.json` y el smoke altera `engine/evidence/smoke-100-v17.json`. La restauración anterior fallaba al reimportar. El workflow ahora elimina únicamente `gauss/nemesis/engine/` en su checkout temporal y reimporta el archivo SHA-256 fijado; se comprobó byte a byte la identidad de los 297 archivos tras la restauración.
- Un archivo ZIP deliberadamente alterado fue rechazado antes de crear `engine/`.
- La verificación de GAUSS/Rust #89 y de la conservación de sus 1000 operadores pasó en Actions run [35750069495](https://github.com/josuechavando350-png/nexus-engine/actions/runs/35750069495); el job `gauss-integration` en esa revisión falló porque la fuente JS todavía no estaba en GitHub.

La prueba anterior es **local**, no una ejecución del CI en el commit de integración final. El ZIP sigue pendiente de carga en la rama; ejecutar otra vez todas las comprobaciones sobre el mismo commit después de incorporarlo. No fusionar si queda un check rojo, si hay SKIP de requisitos obligatorios o si el alcance original de los motores permanece incompleto.
