# APIs ampliadas de Némesis v11

Importaciones públicas desde `src/index.mjs`. Todos los modos del registro usan `runMotor(id,{action,payload})`. El motor #01 conserva `verifyFiniteSystem` / `verifyFiniteProgram`. Los modos anteriores de #02–100 se conservan cuando no hay campo `action`.

| ID | Acciones nuevas | Funciones públicas |
|---|---|---|
| 03 | `enumerate` | `enumerateBimatrixEquilibriumPolytopes` |
| 04 | `evaluate`, `train` | `evaluateDiagonalQAOA`, `trainDiagonalQAOA` |
| 46, 96 | `filter` | `filterTimeVaryingFactorKalman` |
| 49, 99 | `inferGraph`, `trainGraph` | `inferGraphCRF`, `trainGraphCRF`, `graphCRFLoss` |
| 55 | `train`, `loss`, `infer` | `initializeGraphNetwork`, `trainGraphNetwork`, `graphNetworkLoss`, `inferGraphNetwork` |
| 61 | `accounted` | `createPrivateIngestionLedger` |
| 68 | `simulate`, `moments` | `simulateFinitePopulationGame`, `finitePopulationMoments` |
| 69 | `encrypt`, `decrypt` | `generateLatticeStorageKeypair`, `encryptLatticeStorage`, `decryptLatticeStorage` |
| 82 | `train`, `loss`, `infer` | `trainPhysicsLSTM`, `physicsLSTMLoss`, `inferPhysicsLSTM` |
| 83 | `full`, `stream` | `fullJacobiSVD`, `createIncrementalSVD`, `streamSVDChunks` |
| 87 | `evaluate`, `fit`, `simulate` | `evaluateMultivariateHawkes`, `fitMultivariateHawkes`, `simulateMultivariateHawkes` |

## #03 — familias de equilibrios

`payload={rowPayoffs,columnPayoffs,maxVertexSystems?}`. Pagos racionales como strings (`"1/3"`, `"-2"`). Hasta 5 estrategias por jugador. El resultado representa el conjunto completo del juego de entrada como unión de `convexHull(rowVertices) × convexHull(columnVertices)` para todas las familias devueltas. Se permiten familias solapadas. Los soportes enumerados pueden contener ceros en la frontera. Si se excede el presupuesto se lanza error; no se declara completitud parcial.

## #04 — entrenamiento QAOA local

Evaluación: `{costs,layers,angles}`; `costs` es la diagonal completa del Hamiltoniano, con longitud potencia de dos (4–1024). `angles` contiene primero todas las gammas y después todas las betas. Entrenamiento: `{costs,layers,seed,initialAngles?,starts?,iterations?,tolerance?,goal?}`. `goal` es `maximize` o `minimize`.

Simulación clásica de amplitudes, diferenciación automática exacta de esa evaluación numérica, hasta 8 capas sujetas al presupuesto de trabajo. La búsqueda de ángulos se restringe a [-π,π]; no presupone periodicidad para todos los Hamiltonianos reales. Se devuelve el óptimo clásico por enumeración y la brecha de expectativa. La convergencia del optimizador no prueba el óptimo global de los ángulos.

## #46 / #96 — Kalman de factores

`{initialMean,initialFactor,steps}`. Cada paso contiene `transition`, `processFactor`, `observationMatrix`, `observationFactor`, `observation`, y opcionalmente `offset`. Factores triangulares inferiores S describen covarianzas `S Sᵀ`. Se permiten factores de estado/proceso semidefinidos. `observation` usa `null` para canales ausentes. El algoritmo marginaliza esos canales incluso cuando el ruido original está correlacionado.

La predicción y actualización usan QR Givens sobre factores. Una covarianza de innovación singular se rechaza explícitamente. No se implementa pseudoinversa ni se afirma cubrir filtros singulares generales. El historial devuelve factores, medias, canales observados e incrementos de log-verosimilitud.

## #49 / #99 — CRF de grafos

Grafo: `{variables:[cardinalidades],factors:[{scope:[indices],features:[vectores]}]}`. La tabla de cada factor está en orden lexicográfico del `scope`, última variable cambia más rápido. Cada fila contiene los valores de las funciones características; sus pesos son globales y aprendibles.

Inferencia: `{graph,weights}`. Entrenamiento: `{examples:[{graph,labels}],initialWeights,l2?,iterations?,tolerance?}`. Se obtiene partición, marginales, características esperadas y MAP por enumeración exacta de hasta 65536 configuraciones, sujeta además a presupuesto de operaciones. Permite factores de orden superior y grafos cíclicos. No es un algoritmo escalable de inferencia aproximada para grafos grandes.

## #55 — GCN multicapa

`initializeGraphNetwork({dimensions:[entrada,...ocultas,clases],seed})` genera pesos iniciales reproducibles. Entrenamiento: `{model,examples:[{features,adjacency,labels}],l2?,iterations?,tolerance?}`. Los labels `null` no participan en la pérdida; sus características sí forman parte del grafo transductivo. Capas `{weights,bias,activation}` con activación `tanh` o `linear`; salida lineal multiclase.

Inferencia sin etiquetas: `{model,graphs:[{features,adjacency}]}`. Normalización simétrica `D^-1/2(A+I)D^-1/2`, grafo no dirigido. Hasta 8 capas, 128 nodos y presupuestos explícitos. La regresión comprueba gradientes y clasificación de nodos no etiquetados de ejemplos sintéticos; no mide rendimiento con datos reales.

## #61 — privacidad persistente

```js
const ledger = createPrivateIngestionLedger({databasePath, secret, budgetEpsilon});
try {
  const release = ledger.ingest({
    requestId:'release1', categories:['yes','no'], epsilon:0.2,
    records:[{subjectId:'person-1',value:'yes'}]
  });
  const accounting = ledger.accounting('person-1', 1e-6);
} finally { ledger.close(); }
```

`secret` es un Buffer de 32 bytes que el llamador custodia. El modo JSON `accounted` recibe `{databasePath,ledgerSecretHex,budgetEpsilon,request}`. No imprima ni publique archivos que contengan ese secreto. No hay claves reales empaquetadas.

Se carga ε por registro y sujeto con redondeo conservador a nanonats. La composición básica es la suma; se puede consultar además una cota de composición avanzada con δ explícito. **La política de admisión impone la cota básica pura**, no la avanzada. SQLite `BEGIN IMMEDIATE` hace atómica la reserva multisujeto. Un rechazo no consume presupuesto; una respuesta ya comprometida sí lo consume aunque falle el transporte posterior. Repetir `requestId` con los mismos datos recupera exactamente la misma publicación sin nuevo cargo; con datos distintos falla.

El archivo conserva etiquetas HMAC de sujetos, publicaciones privatizadas y metadatos. No conserva valores originales ni IDs de sujetos en claro. Los IDs de petición sí son públicos en el libro. El propietario debe autenticar identidades, custodiar el secreto, proteger el archivo y evitar restauraciones maliciosas de un estado anterior: este módulo local no impide a quien controla el almacenamiento borrar o retroceder el libro. Las pruebas incluyen cuatro procesos compitiendo por un mismo presupuesto.

## #68 — población finita

`{counts,payoffs,mutation,selection?,generations,seed,replicates?}`. Cada generación muestrea N descendientes multinomiales de las frecuencias seleccionadas y mutadas. La aptitud relativa es `1 + selection*(payoff-minPayoff)`. `moments` recibe el mismo modelo sin parámetros de simulación y devuelve media/covarianza analíticas para una generación. Población máxima un millón, presupuesto de 10 millones de muestreos y un millón de números de historial. Es simulación estocástica real con PRNG reproducible; no sustituye estimación de parámetros o validación empírica.

## #69 — almacenamiento cifrado

```js
const {publicKey,privateKey} = generateLatticeStorageKeypair();
const container = encryptLatticeStorage({publicKey,data:Buffer.from('ejemplo'),context:'tenant:document:v1'});
const data = decryptLatticeStorage({privateKey,container,expectedContext:'tenant:document:v1'});
```

ML-KEM-768 establece una clave; HKDF-SHA256 deriva la clave AES-256-GCM. El encabezado canónico vincula versión, algoritmo, destinatario, contexto, longitud, encapsulado KEM, sal y nonce mediante AAD. Límite 16 MiB. No hay fallback a LWE educativo. Los formatos PEM públicos/privados se admiten a través del modo JSON; las APIs aceptan `KeyObject`. No se persisten claves en los ejemplos.

La integridad AEAD **no autentica la identidad del remitente**: cualquiera con la clave pública puede crear un nuevo contenedor válido. El formato tampoco detecta replay por sí mismo. Autorización, KMS, rotación y control de versiones son responsabilidad de la aplicación consumidora. Las pruebas del envelope usan primitivas nativas; no constituyen una revalidación independiente de la implementación ML-KEM de Node/OpenSSL.

## #82 — LSTM informada por física

Modelo: `{gates:{input,forget,output,candidate},peepholes,readout}`. Cada gate tiene `{input,hidden,bias}`. `peepholes` tiene tres filas (input/forget/output); `readout` tiene `{weights,bias}`. Entrenamiento: `{model,sequences:[{inputs,times,targets?}],residuals?,physicsWeight?,l2?,iterations?,tolerance?}`. Targets `null` omiten solo ese término supervisado.

Residuos: números, variables `t`, `x0...`, `y0...`, `dy0...`, o `{op,args}` con `add`, `sub`, `mul`, `square`, `sin`, `cos`, `exp`. Ejemplo para `dy/dt + y = 0`:

```json
{"op":"add","args":["dy0","y0"]}
```

`dy` se aproxima por diferencia temporal hacia atrás; no hay residuo en el primer instante. La pérdida es MSE supervisado medio + `physicsWeight` por MSE físico medio + penalización L2. BPTT entrena todos los gates, conexiones peephole y readout. Hasta 8 entradas/estados ocultos/salidas, sujeto al presupuesto de tape. Inferencia sin etiquetas: `{model,sequences:[{inputs,times}]}`. No se afirma solución de una PDE general ni optimalidad global del entrenamiento no convexo.

## #83 — SVD

`full`: `{rows,tolerance?,maxSweeps?}`. Jacobi unilateral sobre A directamente; no forma `AᵀA`. Devuelve componentes no nulas según tolerancia, valores singulares, residuo de reconstrucción y estado de convergencia. Hasta 4096 filas y 64 columnas, sujeto a presupuesto.

`stream`: `{dimension,rank,chunks,tolerance?}`. La API `createIncrementalSVD({dimension,rank}).append(row)` permite consumir una fila a la vez sin retener datos históricos. Conserva valores singulares y vectores derechos; no conserva U histórica. `snapshot()` incluye una cota conservadora acumulada del error Frobenius de compresión. El modo JSON ya tiene los chunks materializados por el lector JSON; para entrada realmente incremental use la API. No es una demostración de escala ilimitada ni benchmark de almacenamiento externo.

## #84 / #85 — certificados corregidos

#84 mantiene el contrato original de MDP descontado y recalcula la política greedy usando los valores finales. #85 mantiene el contrato original de QP; devuelve multiplicadores duales no negativos y `primalDualGap` calculado con el residuo de estacionariedad y complementariedad. El parámetro de barrera no ejecutado ya no reduce artificialmente la cota. `ITERATION_LIMIT` bloquea el pipeline. Sigue requiriendo H definida positiva y un punto inicial estrictamente factible; no es un solver SOCP/SDP ni detector general de infactibilidad.

## #87 — Hawkes multivariante

Parámetros: `{baseline:[mu_i],alpha:[[alpha_ij]],beta}`. `alpha_ij` excita el proceso i después de un evento j. Kernel `alpha_ij*exp(-beta*dt)` con beta compartida y prehistoria vacía; hasta 8 procesos y 10000 eventos estrictamente ordenados.

- `evaluate`: `{parameters,events:[{time,type}],horizon}`.
- `fit`: `{initial,events,horizon,fitBeta?,l2?,iterations?,tolerance?}`. Ajusta baseline, excitación y opcionalmente beta. El score analítico se comprueba por diferencias finitas.
- `simulate`: `{parameters,horizon,seed,maxEvents?,maxCandidates?}`. Thinning con cota decreciente para excitaciones no negativas; si supera presupuesto lanza error sin devolver simulación truncada como completa.

La cota de suma de filas del operador de ramificación da una **condición suficiente**, no necesaria, de estacionariedad. El ajuste no impone estacionariedad. Se devuelven errores estándar asintóticos a partir de información observada solo si el óptimo es interior, convergente, no penalizado y la matriz es definida positiva; en otro caso `uncertainty.available=false` explica la razón. No se afirma calibración universal ni óptimo global al aprender beta.
