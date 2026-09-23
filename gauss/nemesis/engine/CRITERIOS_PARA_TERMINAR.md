# Cierre del alcance original de Némesis

La referencia de requisitos son las ocho capturas entregadas por el usuario. Están vinculadas por ID en `docs/MATRIZ_100_MOTORES.json`. La v11 no cierra globalmente los 100 motores.

Un cierre debe vincular cada capacidad exigida a código invocable, contrato de entrada/salida, límites, pruebas con resultados verificables y ejecución integrada. Una interfaz registrada no sustituye esa evidencia. La presencia de límites de recursos razonables no invalida por sí sola una implementación; sí debe declararse qué familias de problemas aún no resuelve.

## Tres sustituciones pendientes claras

- **81:** implementar un esquema de firma basado en isogenias con parámetros, claves, firma, verificación y serialización. La isogenia Vélu actual no firma. ML-KEM de #69 es un KEM de retículas y no cumple este requisito.
- **89:** implementar un esquema FHE con evaluación pública y bootstrapping real; demostrar evaluación que supera el presupuesto inicial gracias al refresco. El esquema parcial de enteros actual no lo hace.
- **95:** lenguaje/circuitos de ejecución, generación de witness, prover y verifier de un zk-SNARK concreto. La prueba Schnorr afín actual no es sucinta ni general.

## Pendientes restantes

Consultar los 100 renglones de la matriz y los límites por API. Entre otros: protocolos distribuidos reales en #43/#93; aprendizaje/inferencia general de los modelos causales; métodos de continuación y solvers más amplios; entrenamiento de TGAT/CapsNet; requisitos de escala y validación numérica todavía abiertos.

Las garantías de programas arbitrarios, acontecimientos desconocidos, identificación sin supuestos o inversión física del tiempo necesitan reformularse en objetivos computables. No se fabricarán pruebas que den por cumplidas esas afirmaciones.

Una auditoría externa o certificación de terceros **no se establece como condición para escribir el código solicitado**. No se afirma que esta entrega haya pasado una revisión externa. La custodia de claves, datos reales, identidad, despliegue y garantías de operación se distinguen de la implementación local y se documentan cuando correspondan.

## Actualización v15

El contrato de circuito nativo #89 deja de estar limitado en JavaScript a una suma de bytes: ahora valida y envía DAG booleanos completos acotados. Falta compilar y ejecutar las pruebas Rust, revisar la procedencia del ejecutable y, para uso remoto, separar claves, servidor y cliente. #95 requiere pin de clave externo, pero aún debe superar Groth16 real. La firma de isogenias #81 y el resto de requisitos no se han cerrado.
