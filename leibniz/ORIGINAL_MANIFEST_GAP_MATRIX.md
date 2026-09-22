# LEIBNIZ / matriz de brechas del manifiesto original — línea base

**Fuente de autoridad:** `Especificacion_Absoluta_Nexus_Gauss.pdf`, seis páginas aportadas por el propietario. El documento se conserva fuera de este repositorio público por su carácter confidencial; aquí solo se registran identificadores de sección y expectativas técnicas mínimas sin reproducir el texto íntegro ni planes comerciales. Esta tabla no altera sus requisitos, ni infiere que el alcance de LEIBNIZ aislado sea igual al de NEXUS × GAUSS.

**Estados:** `VERIFICADO_ACOTADO` = evidencia ejecutada, únicamente dentro de las restricciones expresas; `PARCIAL` = existe parte real pero falta la aceptación de extremo a extremo; `SIN_EVIDENCIA` = no se ha demostrado con las fuentes examinadas, *no significa que no exista código en otro lugar*; `NO_CERTIFICABLE_LITERAL` = promesa absoluta que no puede probarse para cualquier fuente, entorno o futuro. Ningún porcentaje global es válido hasta recuperar la lista original detallada de los 100 motores y definir la aceptación de cada uno. `PROVEN` se reserva a conclusiones derivadas con pruebas válidas; no lo confiere un umbral numérico por sí solo.

| ID | Origen (sección/página) | Requisito observable de aceptación | Evidencia inspeccionada | Estado | Brecha de cierre |
|---|---|---|---|---|---|
| M-01 | §1, p. 2 | Módulos nativos ejecutables, sin retornos fijos que suplanten resultados | `leibniz/rust/src/`, CI `leibniz-fase18.yml` | PARCIAL | Auditar cada módulo del sistema, no solo el crate |
| M-02 | §1, p. 2 | Abstención explícita por límite de trabajo o datos insuficientes | `leibniz/rust/tests/inference.rs`, `tests/operational_acceptance.rs` | VERIFICADO_ACOTADO | Ejercitar frontera completa, no solo razón lógica |
| M-03 | §2, p. 2 | Ingesta autorizada, trazable, continua y acotada | Solo archivos semánticos locales en `leibniz/rust/src/semantic_archive.rs` | SIN_EVIDENCIA | Adaptador de fuentes autorizadas, procedencia independiente y pruebas de fallo |
| M-04 | §2, p. 2 | Transformación de ingesta en entidades, restricciones y flujos tipados | `leibniz/rust/src/schema.rs`, `src/semantics.rs` | PARCIAL | Probar con ingesta verdadera y múltiples clases de dato |
| M-05 | §2, p. 2 | Envío de problemas generados a ejecutor GAUSS real | `leibniz/fase18-payload/gauss_bridge_smoke.mjs` | PARCIAL | Reemplazar constantes sintéticas por contrato versionado de carga variable |
| M-06 | §2, p. 2 | Simulaciones GAUSS de escenarios con validación y límites de recursos | `gauss/core/problem.mjs` y un caso lineal sintético | SIN_EVIDENCIA | Ensayar las familias exigidas, tamaño de carga y validez matemática |
| M-07 | §2, p. 2 | Estados PROVEN, ESTIMATED, UNIDENTIFIABLE y ABSTAIN de extremo a extremo | `leibniz/rust/src/handoff.rs` define los cuatro estados | PARCIAL | Mapear respuestas GAUSS reales sin confundir ejecución numérica y demostración lógica |
| M-08 | §2, p. 2 y §4B, p. 5 | PROVEN sustentado por certificado verificable, no por un umbral | `leibniz/rust/src/hol.rs`, `src/formal_audit.rs` | PARCIAL | Verificar aplicación de la regla en la salida combinada real |
| M-09 | §2, p. 2 y §4B, p. 5 | ESTIMATED solo con calibración empírica identificada y vigente | `leibniz/rust/src/handoff.rs` clasifica estimación como `EstimateStructureOnly` | SIN_EVIDENCIA | Dataset independiente, métricas y pruebas fuera de muestra |
| M-10 | §2, p. 2 y §4B, p. 5 | UNIDENTIFIABLE / ABSTAIN por motivos identificables y vinculados a ejecución | `leibniz/rust/src/handoff.rs`, `tests/handoff.rs` | PARCIAL | Propagar y validar estados del ejecutor real |
| M-11 | §3, p. 3 | Orquestador Rust de proceso completo | Crate Rust aislado y `gauss/core/problem.mjs` independiente | SIN_EVIDENCIA | Unir protocolos con un orquestador probado |
| M-12 | §3, p. 3 | Ontología con identidad, restricciones, dimensiones y vigencia | `leibniz/rust/src/schema.rs`, `src/semantics.rs`, `src/semantic_archive.rs` | VERIFICADO_ACOTADO | Probar semántica de las fuentes reales y restricciones comerciales |
| M-13 | §3, p. 3 | Compilador criptográfico de prueba de ejecución, verificable externamente | `leibniz/rust/src/hol.rs` es verificador lógico, no prueba de conocimiento cero | SIN_EVIDENCIA | Especificación del enunciado, circuito, claves y verificador criptográfico; no llamar ZK al hash |
| M-14 | §3, p. 3 | Algoritmos causales/dinámicos invocados sobre problemas válidos | Listado de rutas de GAUSS en el manifiesto; no probado en CI de LEIBNIZ | SIN_EVIDENCIA | Aceptación por algoritmo, validez de supuestos, comparación independiente |
| M-15 | §3, p. 3 | Regresiones y pruebas de estrés integradas | `.github/workflows/leibniz-fase18.yml`: 225 Rust debug + release, un cruce sintético | PARCIAL | CI del monorepo, casos reales y cargas objetivo |
| M-16 | §3, p. 2–3 | Operación privada, local y sin dependencia de API comercial en producción | Crate Rust offline; GitHub conectado es repositorio público y CI usa runners externos | PARCIAL | Instalación local privada, auditoría de dependencias y pruebas sin red |
| M-17 | §4A, p. 4 | Campos y tipos originales `Entity`, `Restriction`, `Flow` conservados | `leibniz/rust/src/schema.rs` y `tests/semantics.rs` | VERIFICADO_ACOTADO | Compatibilidad del modelo en todos los componentes de NEXUS |
| M-18 | §4B, p. 5 | Regla de estabilidad sustentada por modelo formal y premisas demostradas | Estados tipados en `handoff.rs`, sin inferir prueba de una cifra | SIN_EVIDENCIA | Contrastar estabilidad con modelo, observaciones y contraejemplos |
| M-19 | §5, p. 6 | Datos y resultados accesibles solo al operador autorizado | Pruebas de permisos locales en `tests/persistence.rs` | PARCIAL | Despliegue en servidores propios, claves, RBAC, aislamiento y auditoría |
| M-20 | §5, p. 6 | Inventario original de 100 motores trazado uno a uno | El PDF **menciona** 100 motores sin enumerarlos | SIN_EVIDENCIA | Recuperar inventario original íntegro; nunca equiparar 4 bloques con 100 motores |
| M-21 | §5, p. 6 | Resultados comerciales o tasas de acierto respaldados por observación | No se ha proporcionado medición prospectiva independiente | NO_CERTIFICABLE_LITERAL | Definir población, ventana, métricas y margen de error; no prometer acierto absoluto ni ganancias |

## Siguiente puerta de aceptación

1. El contrato general de subconjunto LEIBNIZ→GAUSS debe usar archivos semánticos genuinos, **bytes fijados independientemente**, parámetros de problema explícitos, límites y procedencia conservada. Probar más de un valor, más de un registro y manipulación de entradas.
2. Probar el puente frente a `gauss/core/problem.mjs` y Quantum reales, sin modificar dichos componentes ni `main`. Una operación aritmética ejecutada **no** certifica causalidad ni pronósticos.
3. Registrar en esta tabla la ejecución exacta (commit + Actions run + logs), sin ascender una fila por la sola existencia de un archivo o de una prueba sintética.
4. Para declarar 100 % completo falta el inventario original de los motores y una matriz que incluya cada capacidad, sus entradas, límites y criterios verificables. Los absolutos físicamente o computacionalmente imposibles se declaran como tales, no se falsifican.
