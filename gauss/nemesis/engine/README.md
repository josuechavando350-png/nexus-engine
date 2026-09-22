# Némesis — versión 17 (avance no certificado)

Conserva los 100 IDs. Esta versión endurece dos límites concretos: el #89
acepta datos privados **solo por stdin** en el ejecutable Rust, y el #95
rechaza diagnósticos ambiguos del verificador Groth16, acepta pins opcionales
externos de los ejecutables y evita volcar testigos en errores de subprocesos.
El código Rust y los procesos Groth16 todavía necesitan ejecución nativa en un
entorno con sus herramientas y claves reales; no se certifican los 100 motores.
Ver [docs/API_V17.md](docs/API_V17.md),
[evidence/RELEASE_V17.json](evidence/RELEASE_V17.json) y el inventario de alcance.

---

# Némesis — versión 15

Nuevo compilador de DAG booleanos y adaptador nativo TFHE para #89, transferencia privada por stdin y pin opcional de ejecutable; refuerzo de confianza en las claves Groth16 de #95 y pruebas deterministas adicionales. **No se han cerrado ni certificado los 100 motores**. Requisitos, pruebas y resultados: [docs/API_V15.md](docs/API_V15.md) y [evidence/RELEASE_V15.json](evidence/RELEASE_V15.json). El estado v14 que sigue es histórico.

---

# Némesis — versión 14

Esta entrega parte de la versión 13 y añade un compilador R1CS/Circom al motor #95, su adaptador Groth16 verificable solo con herramientas/ceremonia reales y un adaptador Rust TFHE para #89. **No certifica 100/100 ni el cierre de #81/#89/#95**. La ejecución local de Groth16 y Rust está pendiente: no hay `circom`, `snarkjs`, `cargo` ni `rustc` en el entorno de esta entrega. El código, las pruebas y los comandos reproducibles están en [docs/API_V14.md](docs/API_V14.md).

La información de versión 13 que sigue es evidencia histórica, no una nueva ejecución:

---

# Némesis — versión 13

Proyecto local e independiente con los 100 IDs originales. **El alcance original completo de los 100 motores no está cerrado.** Los cambios de esta entrega se ejecutan en JavaScript; el backend Rust de #89 conserva su estado de verificación pendiente.

Validación de esta entrega: **384 pruebas JavaScript aprobadas, 0 fallos**, 100 ejemplos con resultado esperado y pipeline de ajuste/calibración aprobado. Esto no equivale a cerrar el alcance original de los 100 motores.

## Cambios comprobables de v13

| Motor | Implementación |
|---|---|
| #51 | Residuo del punto fijo sobre valores devueltos; cota de error bajo contracción. CLI y pipeline rechazan `converged:false` de cualquier motor. |
| #66 | Densidad Clayton multivariante, muestreo gamma, ajuste por máxima verosimilitud y evaluación de colas con observaciones reservadas. |
| #70 | Homología F2 incremental: conserva columnas previas, reduce las nuevas y revierte lotes fallidos. Flujos de puntos multidimensionales a radio fijo. |
| #71 | KL y entropía diferencial gaussianas multivariantes y de densidades constantes por tramos, con soporte incompatible explícito. |

Contratos, supuestos y límites: [docs/API_V13.md](docs/API_V13.md).
Se conservan las ampliaciones de [v11](docs/API_V11.md) y [v12](docs/API_V12.md).

## Ejecutar

Con Node.js 24.19.0 o posterior, desde esta carpeta:

```sh
npm test
npm run smoke:100
node cli.mjs motor examples/v13/motor-66-evaluate.json 66
node cli.mjs motor examples/v13/motor-70-points.json 70
node cli.mjs motor examples/v13/motor-71-gaussian.json 71
node cli.mjs pipeline examples/v13/pipeline-copula-held-out.json
```

Los modos nuevos usan `{action, payload}`. Los contratos anteriores sin `action` conservan sus funciones. El CLI devuelve 1 ante falta de convergencia/verificación y 2 ante entrada inválida o error de ejecución. Un optimizador convergente no implica optimalidad global ni veracidad de sus supuestos.

## Rust #89

```sh
npm run verify:fhe
```

Este comando requiere `rustc` y `cargo` en la máquina donde se ejecute. Genera el lockfile si falta, ejecuta las pruebas y guarda su resultado. No se instaló Rust nuevamente en esta entrega. El código Rust de TFHE sigue separado del registro JavaScript #89 y no ha sido compilado aquí. Consulte [native/fhe/README.md](native/fhe/README.md).

## Evidencia

- `evidence/test-log-v13.txt`: suite JavaScript de esta entrega.
- `evidence/smoke-100-v13.json`: ejecución de los 100 ejemplos; el #12 debe rechazar el riesgo que supera el límite.
- `evidence/pipeline-copula-v13.json`: datos sintéticos separados para entrenamiento y evaluación, parámetros ajustados y frecuencias de cola.
- `evidence/RELEASE_V13.json`: cambios y hashes frente a v12.
- `evidence/SHA256SUMS_V13.txt`: integridad del paquete actual.

Las evidencias v11/v12 son históricas; sus hashes se refieren a sus propias entregas. Un hash o una prueba aprobada no certifica todas las propiedades posibles del motor.

## Alcance restante

[docs/MATRIZ_100_MOTORES.json](docs/MATRIZ_100_MOTORES.json) conserva el inventario de los 100 motores, el alcance auditado y los cambios posteriores. [ALCANCE_Y_ESTADO.md](ALCANCE_Y_ESTADO.md) mantiene el cuadro histórico y sus actualizaciones.

Quedan implementaciones e integraciones: entre ellas firma por isogenias #81, zk-SNARK general #95 y ejecución/integración del backend nativo #89. #70 admite inserciones, no eliminación ni ventanas zigzag; #66 se limita a Clayton positiva; #71 no cubre densidades arbitrarias. Tampoco se han demostrado garantías universales de los modelos físicos o causales.

El cifrado ML-KEM de #69 no sustituye #81, #89 ni #95. El modo legado didáctico #69 no protege secretos: para cifrado de datos use su acción `encrypt`/`decrypt`, documentada en v11. Las capturas originales permanecen en `docs/referencias/` como referencia de alcance. No se modifican servicios externos.


## Verificaciones adicionales

- `npm run verify:mlkem` valida el motor #69 si el runtime soporta ML-KEM; en Node sin ese soporte emite evidencia `SKIPPED_UNSUPPORTED_NODE` sin degradar la criptografía.
- `npm run verify:fhe` intenta compilar y probar el backend Rust TFHE de #89 cuando Rust está disponible.
- `npm run verify:snark` permite validar el flujo Groth16 de #95 con `circom`, `snarkjs`, `.ptau` y `.zkey` confiables.
