> **INSTANTÁNEA HISTÓRICA de la entrega 01–60. Las cifras y afirmaciones de estado de este archivo quedaron obsoletas; consulte README.md y ALCANCE_Y_ESTADO.md para el estado actual.**

# NEMESIS · Motores 01–60 (implementaciones acotadas, lote reproducible)

Software ejecutable y auditado por pruebas, **sin dependencias npm externas**. Verifica todas las trayectorias de un **modelo finito** mediante los ocho operadores temporales de CTL. La versión 2 también interpreta un lenguaje imperativo finito, explícito y tipado (JSON AST), enumera **todos** sus estados alcanzables y verifica el modelo generado. No es un analizador genérico de JavaScript/TypeScript ni una prueba del comportamiento de un servicio desplegado.

## Ejecutar

Node.js ≥20. No requiere `npm install`, Internet, credenciales ni otro proveedor.

```sh
npm test
node cli.mjs verify examples/safe-finite-system.json       # PASS; 0
node cli.mjs verify examples/safe-workflow.json            # FAIL; 1
node cli.mjs program examples/finite-program-safe.json    # PASS; 0
node cli.mjs program examples/finite-program-unsafe.json  # FAIL; 1, ruta y acción que conducen al fallo
node cli.mjs program-agent examples/finite-program-safe.json submit approve  # verificación antes de actuar; 0
node cli.mjs agent examples/verified-agent.json submit approve               # agente por tabla; 0
```

Códigos de salida del verificador CTL: `0` = todas las propiedades **requeridas** verificadas, `1` = existe una propiedad requerida falsa, `2` = entrada inválida, error de capacidad/cota, o acción rechazada. En el CLI de motores, `0` indica ejecución correcta dentro de su semántica, incluyendo plan `DRY_RUN` del #18; `1` indica un control incumplido y `2` error de entrada/ejecución. En particular, **sobrepasar un límite jamás produce PASS**.

## Modelo finito explícito original

`verifyFiniteSystem({ model, properties })` recibe JSON como `examples/safe-finite-system.json`. `model` requiere `states` (1–512 identificadores únicos), `initialStates` (≥1), `transitions` (≤65536 aristas `{from,to}`), `atomicPropositions` (vocabulario explícito, ≤256) y `propositions` (etiquetas para **cada** estado). Se comprueba que todos los estados de inicio cumplan todas las propiedades requeridas. Etiquetas/proposiciones desconocidas, claves extra, transiciones duplicadas y modelos inconsistentes se rechazan. Los deadlocks tienen autobucle semántico de stuttering **solo para CTL**.

Las fórmulas son AST JSON y nunca se evalúan como código arbitrario. Se aceptan las constantes `TRUE`, `FALSE`, átomos `ATOM`, booleanos `NOT`, `AND`, `OR`, `IMPLIES` y CTL `EX`, `AX`, `EF`, `AF`, `EG`, `AG`, `EU`, `AU` (until fuerte). Ejemplos: `{"op":"AG","arg":{"op":"ATOM","name":"safe"}}`, `{"op":"AU","left":{"op":"ATOM","name":"pending"},"right":{"op":"ATOM","name":"done"}}`. Se admiten hasta 128 propiedades, 4096 nodos AST sumados y profundidad 64.

Los resultados publican modelo normalizado, hash SHA-256 del modelo JSON canonizado, conjuntos de estados que satisfacen cada subfórmula, veredicto por estado inicial y diagnósticos específicos: trayectorias para `AG` falso, `EF`/`EU` verdaderos; prefijo+ciclo para `AF` falso y `EG` verdadero. Para otros casos se informan conjuntos completos de estados, sin fabricar testigos de camino inexistentes. Las pruebas contrastan **todos** los ocho operadores con un oráculo independiente de caminos/ciclos en 384 grafos pequeños (7168 evaluaciones) y cubren cadenas de 512 estados.

## Verificación de código: lenguaje de programas finitos

`verifyFiniteProgram({ program, properties })` verifica un programa fuente **en el DSL tipado definido aquí**, no JavaScript. Consulte `examples/finite-program-safe.json` y `examples/finite-program-unsafe.json`. El campo `program` incluye:

- `variables`: mapa de 1–16 variables. Cada variable indica `domain` (1–32 enteros seguros, booleanos o identificadores; **todos del mismo tipo**) e `initial` perteneciente a ese dominio.
- `commands`: 0–128 instrucciones `{id, guard, updates}`. `guard` es expresión booleana; `updates` indica expresiones para un subconjunto de variables. **Todas las asignaciones de una instrucción se evalúan en el estado anterior y se aplican simultáneamente.** Instrucciones habilitadas desde un mismo estado representan elecciones no deterministas. Sin instrucciones habilitadas hay deadlock semántico.
- `predicates`: 1–256 expresiones booleanas nombradas que se convierten en proposiciones atómicas sobre cada valuación alcanzable. `properties` usa la misma sintaxis CTL del modo explícito.

Expresiones aceptadas: `{"op":"CONST","value":1}`, `{"op":"VAR","name":"x"}`, `NOT`, `NEG`, `AND`, `OR`, `EQ`, `NE`, `LT`, `LE`, `GT`, `GE`, `ADD`, `SUB`. Los tipos son estrictos; `ADD`, `SUB` y `NEG` trabajan con enteros seguros y rechazan overflow. Asignar un valor fuera del dominio provoca error: no se descarta silenciosamente la transición. No hay `eval`, llamadas externas, E/S, funciones arbitrarias, bucles ni ejecución dinámica. Un ciclo emerge de las instrucciones del programa y se explora como estados finitos.

El compilador hace BFS a partir de la valuación inicial y enumera **todas** las valuaciones alcanzables y las transiciones por instrucción. Se detiene con error cuando hay más de 512 estados o 65536 transiciones alcanzables; **no certifica una exploración truncada**. Las rutas de contraejemplo/testigo incluyen valores de todas las variables y los IDs de instrucciones reproducibles. Para transiciones duplicadas de distintas instrucciones conserva todas las etiquetas en el informe. Los hashes de modelo y programa se generan a partir de representaciones deterministas y canónicas, independientemente del orden de claves e instrucciones.

`createVerifiedProgramAgent(spec)` se niega a construirse si falla alguna propiedad requerida; su método `execute(id)` solo ejecuta transiciones de la **misma relación enumerada y verificada** y emite recibos inmutables `before`/`after` con ambos hashes. Es un intérprete declarativo **en memoria**: no tiene efectos sobre aplicaciones externas.

## Límites de la evidencia

El resultado `PASS` demuestra que la fórmula CTL es verdadera sobre **todas las trayectorias del modelo finito aportado o del DSL enumerado** conforme a la semántica implementada, dentro de sus límites. **No demuestra** que el modelo corresponda a un repositorio, binario, navegador, sistema de producción, API o interacción física. El problema general de decidir la corrección de cualquier programa es indecidible; no existe un «100 % universal» honesto. No hay verificación de programas arbitrarios en JS/TS, abstracción automática de código existente, motor simbólico BDD/SAT/SMT, ni certificación independiente del compilador/intérprete.

Los hashes SHA-256 sirven para trazabilidad/reproducibilidad, no como prueba criptográfica de corrección ni autenticidad de datos. Para un uso productivo, se necesita un traductor semánticamente justificado desde el programa concreto al DSL y revisión independiente de supuestos y propiedades. Un `PASS` para un predicado incorrecto no significa que el requisito real se satisfaga.

## Pruebas y aislamiento

`npm test` ejecuta las pruebas originales y las adicionales 16–20 (incluidas pruebas de oráculo independiente, regresión, integración e inventario), incluyendo los 15 casos originales, 13 pruebas del DSL (seguridad, vivacidad, ciclos, estados límite, rechazo de entrada, reordenamiento y oráculo independiente para 256 programas de 3 valores), más 2 de agente verificado. El conjunto de entrada y salida incluye fixtures separados de programa válido y violación reproducible. Los tests adicionales de los motores 02–10 incluyen comparaciones numéricas analíticas, comprobaciones criptográficas de manipulación y réplicas worker reales. El proyecto se puede alojar dentro de `nemesis/` en Nexus; **el paquete entregado no modifica el repositorio remoto ni proyectos de clientes**.


## Motores 02–60 y estado de las 100 propuestas

Se implementan los motores 02–60 en `src/motors/` con pruebas independientes; las **40 propuestas restantes no están programadas en NEMESIS**. El motor 01 sigue disponible en su propio verificador. Consulte `ALCANCE_Y_ESTADO.md` e `INVENTARIO_100.json` para distinguir implementación acotada de objetivo original completo.

```sh
node --test
node cli.mjs motor examples/causal-confounding.json 02
node cli.mjs motor examples/game-matching-pennies.json 03
node cli.mjs motor examples/qaoa-two-vertices.json 04
node cli.mjs motor examples/hmm-two-hidden-states.json 05
node cli.mjs motor examples/quantum-walk-two-vertices.json 06
node cli.mjs motor examples/kalman-rts.json 07
node cli.mjs motor examples/bayes-event-stream.json 09
node cli.mjs motor examples/mirrored-agent.json 10
node cli.mjs motor examples/selection-conditioning.json 11
node cli.mjs motor examples/finite-tail-risk.json 12       # BREACH; exit 1, riesgo supera control configurado
node cli.mjs motor examples/clock-intervals.json 13
node cli.mjs motor examples/finite-fuzzy.json 14
node cli.mjs motor examples/grammar-repair.json 15
```

No se ha integrado este paquete en GitHub ni en Nexus. No usar como evidencia de que las 100 propuestas están terminadas. El código #08 **no tiene auditoría criptográfica independiente ni es un sistema ZK de propósito general**. El CLI rechaza `commit` para impedir volcar aperturas privadas por stdout; genere compromisos en memoria mediante la API exportada de `zk-opening.mjs`.

## Capacidades nuevas 06–10 y contratos de uso

- **06 — Caminatas cuánticas** (`src/motors/quantum-walk.mjs`): `{mode:"continuous",vertices,edges,start,time}` calcula `exp(-i·t·A)|start⟩` con expansión de Taylor y subpasos acotados, para matrices de adyacencia reales simétricas. `{mode:"discrete",vertices,edges,start,steps}` ejecuta una moneda Grover local y desplazamiento flip-flop en grafo sin aislados, sin ponderaciones. Hasta 12 vértices; normalización verificada, sin hardware cuántico.
- **07 — Kalman RTS** (`src/motors/kalman.mjs`): matrices constantes `F,H,Q,R`, `initialMean`, `initialCovariance`, `observations` con `null` para una observación enteramente ausente. Dimensiones 1–6, hasta 128 pasos; requiere matrices de covarianza simétricas y definidas positivas. Joseph update para estabilidad, suavizado retrospectivo del estado estadístico, no inversión física del tiempo.
- **08 — Conocimiento de apertura Pedersen** (`src/motors/zk-opening.mjs`): `createPedersenCommitment(value)` devuelve compromiso y **apertura privada**; `provePedersenOpening(commitment, opening)` genera prueba pública y `verifyPedersenOpening(commitment, proof)` la comprueba. El valor de la apertura puede ser elegido entre 0 y 10⁹ al crearlo, pero **LA PRUEBA NO ACREDITA ESE RANGO**. Supone seguridad del grupo y modelo de oráculo aleatorio Fiat–Shamir; no sustituyen auditoría ni un SNARK. `node cli.mjs motor <public-proof.json> 08` solo para verificar/probar, nunca para generar secretos por stdout.
- **09 — Bayes de eventos** (`src/motors/bayes-stream.mjs`): `updateBinaryBayesEvents({priorTrue,events})` y `createBinaryBayesStream(prior).ingest(event)` con tiempos enteros, IDs únicos y `likelihoodIfTrue/False` en fracciones acotadas. Máximo 1024 eventos por instancia; `ingest` reproduce en orden temporal y no confirma inserción imposible. Independencia condicional es una **hipótesis de entrada**, no un resultado descubierto.
- **10 — Agentes espejo** (`src/motors/mirror-agent.mjs`): `await runMirroredAgents({states,initial,transitions,schedule,forbiddenStates?,fault?})` lanza dos hilos separados con la misma FSM declarativa, traza estados y compara SHA-256. `fault` solo permite inyectar una desviación explícita en réplica 2 con `step` y `overrideState`. `CONSISTENT` exige ejecución sin errores ni estados prohibidos; `DIVERGED` e `INVARIANT_VIOLATION` salen con código CLI 1. No ejecuta código de terceros ni equivale a consenso tolerante a fallas bizantinas.

Para alcances exactos y lagunas científicas restantes, consulte `ALCANCE_Y_ESTADO.md` e `INVENTARIO_100.json`.

## Capacidades nuevas 11–15 y contratos de uso

- **11 — Sesgo de selección** (`src/motors/selection-bias.mjs`): se aporta prior poblacional `priorTrue`, probabilidad de observación positiva bajo cada hipótesis y cuatro probabilidades de selección condicionadas por hipótesis y observación. Bayes racional exacto calcula prior entre casos seleccionados, probabilidades observacionales condicionales y posterior ingenuo/ajustado entre casos seleccionados. Si una observación tiene probabilidad cero en ambos modelos, se devuelve `null`, nunca un posterior fabricado. No observa ni diagnostica decisiones de personas, ni aprende propensiones desconocidas. La interpretación requiere declarar explícitamente los supuestos de selección.
- **12 — Riesgo de cola finito** (`src/motors/tail-risk.mjs`): `scenarios` contiene 1–128 pérdidas enteras y probabilidades racionales que suman exactamente uno; `alpha` es un nivel estrictamente entre 0 y 1; opcional `maxCvar` establece un control de riesgo. Calcula valor esperado, VaR y CVaR superior con tratamiento exacto de masa empatada en el cuantil. `BREACH` retorna código CLI 1. No identifica sucesos ausentes del modelo ni garantiza seguridad ante catástrofes desconocidas.
- **13 — Restricciones de relojes** (`src/motors/chronos.mjs`): `clocks`, `anchor`, `constraints:[{id,from,to,min,max}]` codifican diferencias de offsets enteros estáticos; Bellman–Ford detecta ciclos negativos y calcula intervalos ajustados al ancla más una asignación válida. `INCONSISTENT` retorna código CLI 1; un grafo desconectado se rechaza. No realiza intercambio de paquetes, sincronización física, estimación de deriva ni consenso bizantino.
- **14 — Lógica difusa de segundo orden finita** (`src/motors/fuzzy-second-order.mjs`): dominio discreto `domain`, predicados unarios fijos `predicates`, universo explícito `predicateUniverse` de 1–16 interpretaciones, fórmulas JSON con `PRED`, `APPLY`, `NOT`, `AND`, `OR`, `IMPLIES`, `FORALL`, `EXISTS`, `FORALL_PRED`, `EXISTS_PRED`. Usa mínimo/máximo y residuo de Gödel, negación estándar, grados racionales exactos. Umbral opcional no alcanzado retorna CLI 1. No cuantifica sobre predicados no incluidos ni decide lógica de segundo orden general.
- **15 — Reparación de expresiones** (`src/motors/grammar-repair.mjs`): AST puro de aritmética entera `CONST`, `VAR`, `ADD`, `SUB`, `MUL`, ejemplos de entradas/salidas, constantes candidatas y presupuesto de hasta dos sustituciones de nodo/operador. Busca sistemáticamente y devuelve el primer AST que supera **todos los ejemplos proporcionados** o `NO_REPAIR_IN_BUDGET` con salida CLI 1. No ejecuta código fuente ajeno, no parchea archivos JS/TS y no demuestra corrección para entradas no cubiertas.

Los 100 nombres originales se conservan en `INVENTARIO_100.txt`. 60 motores disponen de implementaciones acotadas comprobadas; 40 no están implementados aquí. La integración en Nexus no está realizada.

## Lote nuevo 16–20 · componentes ejecutables conectados

Se añadieron cinco motores acotados reales y el auditor `auditIngestionWorkflow()` que usa los cinco y construye un contrato a partir de métricas **calculadas**, sin operar fuentes externas. Los 100 nombres siguen inalterados; los motores 61–100 no están programados. La implementación acotada de los primeros 60 no constituye un producto completo para todas sus disciplinas. Revisar `ALCANCE_Y_ESTADO.md` para los contratos exactos.

```sh
node --test
node cli.mjs motor examples/structural-chain.json 16
node cli.mjs motor examples/cross-domain-ontology.json 17
node cli.mjs motor examples/reverse-ingestion.json 18
node cli.mjs motor examples/dark-data-catalog.json 19
node cli.mjs motor examples/certainty-contract.json 20
node --input-type=module -e "import {auditIngestionWorkflow} from './src/index.mjs'; import {readFileSync} from 'node:fs'; const x=JSON.parse(readFileSync('examples/audited-ingestion.json'));console.log(auditIngestionWorkflow(x).status)"
```

Ed25519 únicamente autentica una firma bajo una clave pública de confianza **aportada por el usuario**, no autentica mediciones, instituciones, ni el mundo real. El ejemplo no incluye secretos ni claves persistentes. No se modificaron archivos de Nexus ni sitios de clientes.


## Lote 21–30

Diez kernels numericos/algoritmicos adicionales, con especificaciones, fronteras y ejemplos en `ALCANCE_Y_ESTADO.md`. `node --test test/motors-21-30.test.mjs` cubre identidades analiticas, verificaciones independientes, entradas adversarias, invocacion por CLI y una composicion 25→30. `INVENTARIO_100.json` distingue 60 implementaciones **acotadas** de 40 ausentes.

```sh
node cli.mjs motor examples/information-simplex.json 21
node cli.mjs motor examples/lorenz96-equilibrium.json 22
node cli.mjs motor examples/ensemble-kalman.json 23
node cli.mjs motor examples/pinn-poisson.json 24
node cli.mjs motor examples/information-diffusion.json 25
node cli.mjs motor examples/stackelberg-three-stage.json 26
node cli.mjs motor examples/persistent-square.json 27
node cli.mjs motor examples/causal-irl.json 28
node cli.mjs motor examples/multivariate-transfer-entropy.json 29
node cli.mjs motor examples/scenario-robust.json 30
```

## Lote 31–40 · diez interfaces reales adicionales

El inventario de los 100 nombres originales no se ha modificado. Los IDs 31–40 implementan **subconjuntos expresos** de las respectivas disciplinas, no algoritmos universales ni pruebas de comportamiento productivo. La ejecución se hace con `node cli.mjs motor examples/<nombre>.json <id>`; los contratos y ejemplos son JSON validados. La criptografía depende de `node:crypto`, que viene con Node; no se envían credenciales a terceros.

| ID | Ejemplo | Implementación acotada |
|---|---|---|
| 31 | `local-contract` | Compilación a bytecode de reglas numéricas, VM sin E/S, hash y atestación Ed25519 mediante API; no EVM ni contratos desplegados. |
| 32 | `dynamic-graph` | Actualizaciones de grafos en memoria, componentes y BFS; no base distribuida ni algoritmo sublineal. |
| 33 | `empirical-mode` | Descomposición EMD de envolventes lineales, cribado y reconstrucción; no EMD cúbica estándar. |
| 34 | `dynamic-bayes` | Filtrado de red bayesiana dinámica binaria mediante tabla conjunta finita conocida; no aprende CPTs. |
| 35 | `stochastic-dp` | Bellman tabular en horizonte finito y dinámica conocida; no aprendizaje en línea. |
| 36 | `cross-map` | Convergent cross mapping de series finitas con embedding y predicción por vecinos; no prueba causal por sí sola. |
| 37 | `spatiotemporal-field` | Campo gaussiano finito con covarianza exponencial separable y Cholesky; no modelo inferido de mediciones. |
| 38 | `constrained-swarm` | PSO heurístico de cuadrática acotada bajo desigualdades lineales; no certificado de óptimo global. |
| 39 | `paillier-public` | Cifrado homomórfico **aditivo** Paillier local, aleatoriedad OS y API de clave privada; NO FHE ni seguridad auditada. |
| 40 | `invariant-safe` | Invariante inductivo de sistema booleano finito, exploración y testigos de fallo; no verificador JS/TS universal. |

Para ejecutar el lote: `node --test test/motors-31-40.test.mjs`. El cifrado de #39 es aleatorio; ejecutar dos veces con la misma clave da ciphertext diferente. El comando CLI de #39 admite **solo clave pública** y nunca imprime una clave privada; generar claves y descifrar requiere llamar a `generatePaillierKeypair()` y `paillierDecrypt()` dentro de un proceso privado. Las claves y firmas de #31 se manejan de modo análogo mediante `signLocalContract()` / `verifyLocalContractSignature()`, no a través del CLI JSON. El verificador de #40 distingue prueba inductiva sobre todo el espacio de valuaciones y chequeo exhaustivo de estados alcanzables.

**Estado de entrega:** 60 implementaciones acotadas probadas, 40 sin código; ninguna se ha integrado remotamente en Nexus. Las pruebas no sustituyen auditoría criptográfica, verificación matemática independiente ni validación de datos del mundo real.


## Lote 41–60 · 20 interfaces comprobables (sin certificación de producción)

Estas implementaciones no resuelven las disciplinas generales indicadas por sus nombres. Cada contrato exacto, límite y exclusión se detalla en `ALCANCE_Y_ESTADO.md` y en `INVENTARIO_100.json`. Los 20 se invocan con `node cli.mjs motor examples/motor-41.json 41`, sustituyendo ambos números por el ID deseado. El ejemplo 45 contiene una prueba generada sin el testigo, el 50 una firma de demostración con **solo clave pública**.

| ID | Kernel realmente ejecutado |
|---|---|
| 41 | Ergodicidad de cadena de Markov finita mediante clases comunicantes y periodo. |
| 42 | Estabilidad espectral de sistema lineal discreto 1×1/2×2 y candidato Lyapunov. |
| 43 | Conteo de quórums PREPARE/COMMIT para transcripción de una vista; sin red ni autenticación implementada. |
| 44 | Métrica y distancia Fisher–Rao en simplex categórico finito. |
| 45 | Demostración educativa Schnorr de logaritmo discreto en grupo MODP14 conocido: **sin auditoría criptográfica ni prueba de ejecución general**. |
| 46 | Kalman lineal multivariado, covarianza Joseph y factorización Cholesky por paso. |
| 47 | Proyección KL categórica bajo una restricción de esperanza. |
| 48 | Barrido de parámetros de mapa logístico y estimadores finitos de Lyapunov/periodo. |
| 49 | CRF lineal finito: forward–backward y Viterbi para potenciales suministrados. |
| 50 | Firma Ed25519 de hashes de estados con clave confiable aportada, contexto y época. |
| 51 | Aproximación factorada de campo medio para modelo Ising. |
| 52 | Retícula de mapas logísticos acoplados y estimación de crecimiento tangente. |
| 53 | Tensor de Ricci analítico del simplex categórico con métrica Fisher–Rao. |
| 54 | Filtro de ángulo con error invariante SO(2) y covarianza escalar. |
| 55 | Capa GCN normalizada con pesos explícitos, sin entrenamiento. |
| 56 | Ecuación de calor estocástica 1D periódica, Euler–Maruyama con cota CFL. |
| 57 | Juego de campo medio de dos estados, mejor respuesta iterativa y residuo. |
| 58 | Inversión de mezcla no lineal **conocida**; no identificación ICA ciega. |
| 59 | GP RBF y expected improvement sobre candidatos explícitos dentro de caja. |
| 60 | LQR estocástico escalar de horizonte finito, ecuación Riccati integrada por RK4. |

`node --test test/motors-41-60.test.mjs` valida casos analíticos, rechazos, CLI, firmas y consistencia. `node --test` ejecuta la regresión completa. La existencia del código no implica que sea apto para sistemas críticos, decisiones financieras, criptografía productiva o Nexus desplegado. **No se ha realizado ninguna integración remota.**
