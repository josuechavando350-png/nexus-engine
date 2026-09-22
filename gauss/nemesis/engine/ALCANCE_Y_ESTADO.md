# Actualización v15

#89 añade compilación validada de circuitos booleanos arbitrarios acotados a un backend TFHE Rust y entrada privada por stdin; no hay ejecución nativa en este entorno. #95 exige un pin de clave de verificación de origen independiente y añade pruebas de propiedades R1CS. #81 y los demás pendientes originales no se consideran terminados. Consultar `docs/API_V15.md` y `evidence/RELEASE_V15.json`.

# Actualización v14

#89: adaptador invocable para ejecutable TFHE en Rust. #95: compilador R1CS/Circom y contrato Groth16 con pruebas negativas y verificación de la ceremonia de claves. No se ejecutaron los backends nativos aquí; **la certificación global sigue pendiente**. Véase `docs/API_V14.md`.

# Actualización v13

Cambios de #51, #66, #70 y #71: consultar `docs/API_V13.md` y los campos `cambios_v13`/`pendiente_actual_v13` de la matriz JSON. La enumeración histórica que sigue no sustituye esa actualización. El alcance global sigue pendiente.

# Actualización v12

#27 añade homología superior verificada; #89 añade código Rust aún no ejecutado. Véase `docs/API_V12.md` y la matriz JSON actualizada. El cuadro de v11 que sigue se conserva como antecedente.

# Némesis — estado por motor, versión 11

Némesis es el nombre del proyecto y del paquete. No depende de GAUSS. Se preservan los 100 IDs originales. La columna de pendientes procede de las capturas aportadas y no describe necesariamente la última versión de aquel proyecto.

**Estado global: trabajo pendiente frente al alcance original.** Esta entrega modifica 15 IDs y ejecuta los 100 ejemplos. No certifica el cierre de los 100 motores.

| ID | Motor | Trabajo v11 | Pendiente de referencia |
|---|---|---|---|
| 01 | Verificación Formal (Lógica de Autómatas) | Implementación anterior conservada. | Verificación de software arbitrario y extracción automática de modelos de código desplegado. |
| 02 | Inferencia Causal (Cálculo de Judea Pearl) | Implementación anterior conservada. | Aprendizaje de estructura causal, identificación observacional, modelos continuos/no binarios y contrafactuales generales. |
| 03 | Teoría de Juegos / Equilibrio de Nash (Montecarlo Masivo) | Enumeración racional de familias de equilibrios mixtos, soportes desiguales y degeneración. | Monte Carlo de juegos grandes; soportes singulares o desiguales, familias continuas y enumeración completa de equilibrios mixtos. |
| 04 | Optimización Cuántica Local (QAOA Simulator) | Entrenamiento con gradiente por diferenciación automática, reinicios y Hamiltonianos diagonales. | Circuitos mayores, otros Hamiltonianos y garantías globales; el simulador solicitado no exige QPU física. |
| 05 | Entropía de Shannon y Variables Ocultas | Implementación anterior conservada. | Aprendizaje de la estructura de variables ocultas y modelos de entropía más generales. |
| 06 | Caminatas Aleatorias Cuánticas | Implementación anterior conservada. | Grafos dirigidos/ponderados arbitrarios, monedas unitarias generales y mayor escala; QPU no es prerrequisito. |
| 07 | Inversión Temporal (Kalman de Orden Superior) | Implementación anterior conservada. | Reconstrucción no lineal, dinámica aprendida o variable, predicciones singulares e inversión temporal física. |
| 08 | Validador Lógico Invariable (Zero-Knowledge Proofs Coherentes) | Implementación anterior conservada. | Validador lógico coherente general y otros circuitos booleanos; certificado externo no es requisito de implementación. |
| 09 | Actualización Bayesiana Asíncrona Continua | Implementación anterior conservada. | Flujos de eventos arbitrarios y familias posteriores bayesianas generales. |
| 10 | Programador de Agentes Espejo | Implementación anterior conservada. | Planificación arbitraria de agentes, aislamiento de código hostil y consenso tolerante a fallos. |
| 11 | Filtro de Sesgo de Confirmación Humana | Implementación anterior conservada. | Diagnóstico cognitivo humano, mediciones calibradas o inferencia causal de selección. |
| 12 | Motor de Aislamiento de Cisnes Negros | Implementación anterior conservada. | Catástrofes desconocidas/no acotadas, probabilidades de cola verificadas y aislamiento garantizado. |
| 13 | Motor de Sincronización de Relojes de Redes Complejas (Chronos Engine) | Implementación anterior conservada. | Sincronización distribuida autenticada, pares bizantinos, estimación de deriva y control de reloj de red. |
| 14 | Resolvedor de Lógica Difusa de Segundo Orden | Implementación anterior conservada. | Lógica difusa tipo 2 general, funciones secundarias arbitrarias, aprendizaje de reglas y universos generales. |
| 15 | Motor de Evolución Gramatical y Mutación de Código (Self-Healing Code) | Implementación anterior conservada. | Parches seguros a código arbitrario, autorreparación productiva y prueba semántica exhaustiva. |
| 16 | Calculador de Robustez Estructural | Implementación anterior conservada. | Simulación estructural mecánica, fallos simultáneos arbitrarios y fiabilidad real. |
| 17 | Motor de Ontología de Dominio Cruzado | Implementación anterior conservada. | Alineamiento universal de ontologías, razonamiento automatizado de dominio y ontologías aprendidas grandes. |
| 18 | Gestor de Fricción de Ingesta Inversa | Implementación anterior conservada. | Reconstrucción CSV byte a byte, formatos no especificados y reverse ETL de todas las fuentes. |
| 19 | Motor de Ingesta de Dark Data | Implementación anterior conservada. | Adaptadores externos, extracción de documentos arbitrarios y descubrimiento de hechos desconocidos. |
| 20 | Compilador de Contratos de Certeza Criptográfica | Implementación anterior conservada. | Certeza sobre el mundo real, identidad externa del firmante y certificación general de contratos. |
| 21 | Motor de Geometría de Información No-Riemanniana | Implementación anterior conservada. | Geometría curva aprendida general, más allá de deformación Randers/Finsler 2D. |
| 22 | Resolvedor de Atractores de Lorenz de Alta Dimensión | Implementación anterior conservada. | Pruebas generales de existencia y validación de atractores, más allá de simulación temporal finita. |
| 23 | Filtro de Kalman Ensamblado de Alta Dimensión | Implementación anterior conservada. | Pruebas a gran escala fuera de memoria y localización del ensamble. |
| 24 | Motor de Redes Neuronales Informadas por la Física (PINN) | Implementación anterior conservada. | PINN profundas y multifísicas generales, más allá de Poisson 1D. |
| 25 | Simulador de Dinámica de Fluidos de Información | Implementación anterior conservada. | PDE multidimensionales generales, datos reales e interpretación física validada. |
| 26 | Multilayer Stackelberg | Implementación anterior conservada. | Compromisos mixtos y juegos multicapa generales. |
| 27 | Persistent-homology TDA | Implementación anterior conservada. | Homología H1 y superior y complejos grandes. |
| 28 | Causal inverse reinforcement learning | Implementación anterior conservada. | Identificación causal, espacios mayores e incertidumbre del experto. |
| 29 | Multivariate transfer entropy | Implementación anterior conservada. | Rezagos multivariantes generales y corrección del sesgo del estimador. |
| 30 | Scenario-robust optimization | Implementación anterior conservada. | Optimización continua y robustez distributiva con conjuntos de ambigüedad. |
| 31 | Cryptographic local smart-contract compiler | Implementación anterior conservada. | DSL general de contratos, aislamiento de ejecución, cómputo de gas y despliegue. |
| 32 | Large-scale dynamic graphs | Implementación anterior conservada. | Grafos distribuidos grandes y almacenamiento de alto rendimiento. |
| 33 | Empirical mode decomposition | Implementación anterior conservada. | Corrección de bordes, EMD por ensambles y multidimensional. |
| 34 | Dynamic Bayesian networks | Implementación anterior conservada. | DAG generales con aprendizaje de estructura y parámetros. |
| 35 | Stochastic dynamic programming | Implementación anterior conservada. | Control estocástico general y escalamiento del espacio de estados. |
| 36 | Causal time series via convergent cross mapping | Implementación anterior conservada. | Pruebas con sustitutos, controles de confusión y validación causal. |
| 37 | Spatiotemporal random fields | Implementación anterior conservada. | MRF grandes y aprendizaje de potenciales. |
| 38 | Constrained particle swarms | Implementación anterior conservada. | Objetivos y restricciones no convexos generales. |
| 39 | Local homomorphic computing | Implementación anterior conservada. | Compilación general y multiplicación/cifrado totalmente homomórfico. |
| 40 | Formal verification of state invariants | Implementación anterior conservada. | Verificación de programas imperativos generales. |
| 41 | Dynamic-network ergodicity | Implementación anterior conservada. | Redes arbitrarias variables en el tiempo. |
| 42 | Lyapunov stability evaluation | Implementación anterior conservada. | Estabilidad no lineal o estocástica arbitraria y estimación de cuencas. |
| 43 | Byzantine replica consensus | Implementación anterior conservada. | Protocolo de consenso ejecutable con red, cambios de vista, vivacidad y cambios de miembros. |
| 44 | Amari Fisher-Rao geometry | Implementación anterior conservada. | Variedades estadísticas generales e integración de gradiente natural. |
| 45 | Zero-knowledge execution proofs | Implementación anterior conservada. | Compilador general de ejecución/circuitos zk-SNARK. |
| 46 | High-velocity square-root Kalman | Kalman multivariable de factores por QR Givens, sin formar covarianza en la actualización. | Actualizaciones multivariantes de factores QR/Cholesky y pruebas de rendimiento. |
| 47 | Causal-economic constrained variational inference | Implementación anterior conservada. | DAG causales aprendidos/identificados y optimalidad variacional global. |
| 48 | Nonlinear bifurcation systems | Implementación anterior conservada. | Sistemas no lineales arbitrarios, continuación de ramas y todas las bifurcaciones. |
| 49 | Stochastic CRF | CRF de grafos y factores generales finitos, inferencia exacta y aprendizaje de todos los pesos. | CRF sobre grafos generales, entrenamiento y aprendizaje de potenciales. |
| 50 | Strict cryptographic invariance signatures | Implementación anterior conservada. | Gestión externa de claves y despliegue distribuido adversarial. |
| 51 | Mean-Field Inference | Implementación anterior conservada. | Distribuciones gráficas generales y convergencia certificada. |
| 52 | Strange Attractors and Spatiotemporal Chaos | Implementación anterior conservada. | Atractores extraños espaciotemporales y exponentes robustos. |
| 53 | Ricci Curvature Tensor for Information Manifolds | Implementación anterior conservada. | Variedades de información aprendidas arbitrarias. |
| 54 | Invariant Group Kalman Filter (Lie Groups) | Implementación anterior conservada. | SE(3), invariancia de grupo de Lie y dinámicas más amplias. |
| 55 | CNNs on Non-Euclidean Graphs | GCN multicapa con entrenamiento por retropropagación y clasificación de nodos. | Entrenamiento de redes sobre grafos y arquitectura más profunda. |
| 56 | Stochastic PDE (SPDE) | Implementación anterior conservada. | SPDE generales y solvers adaptativos. |
| 57 | Mean Field Games | Implementación anterior conservada. | Pruebas de existencia/convergencia y juegos de campo medio continuos generales. |
| 58 | Nonlinear ICA | Implementación anterior conservada. | ICA no lineal ciega; no es identificable sin supuestos adicionales. |
| 59 | Constrained Box Gaussian-Process Bayesian Optimizer | Implementación anterior conservada. | Óptimo global continuo y ajuste de hiperparámetros. |
| 60 | Continuous-Time Stochastic Optimal Control | Implementación anterior conservada. | HJB estocástica no lineal general. |
| 61 | Local Differential Privacy Ingestion Compiler | Ingesta LDP con libro SQLite transaccional, presupuesto por sujeto, idempotencia y composición. | Sistema de ingesta completo y composición avanzada/contabilidad de privacidad. |
| 62 | Temporal-Attention Dynamic Graphs (TGAT) | Implementación anterior conservada. | Entrenamiento y actualizaciones escalables de grafos temporales. |
| 63 | Dynamic Mode Decomposition (DMD) | Implementación anterior conservada. | SVD truncada por rango y Koopman de dimensión superior. |
| 64 | Partially Observable Markov Decision Processes (POMDP) | Implementación anterior conservada. | Espacios generales y aproximación de horizontes largos. |
| 65 | Stochastic Gradient Descent with Quantum Momentum | Implementación anterior conservada. | Optimizador cuántico genuino/QPU; la implementación auditada era clásica. |
| 66 | Archimedean Copulas for Multivariate Risks | Implementación anterior conservada. | Dimensión mayor a dos, estimación de cópula y calibración de colas. |
| 67 | Nonlinear Cointegration of Time Series | Implementación anterior conservada. | Prueba de hipótesis de cointegración con valores críticos calibrados. |
| 68 | Stochastic Evolutionary Games | Dinámica estocástica Wright–Fisher, selección/mutación, replicados y momentos multinomiales. | Dinámica evolutiva estocástica de poblaciones finitas. |
| 69 | Lattice-Based Cryptography Storage Compiler | Almacenamiento binario autenticado ML-KEM-768/HKDF-SHA256/AES-256-GCM con claves externas. | Compilador de almacenamiento con criptosistema seguro; sustituir LWE didáctico inseguro. |
| 70 | Persistent Homology of Dynamic Data Streams | Implementación anterior conservada. | Actualizaciones incrementales de homología H1 y superior en flujos multidimensionales. |
| 71 | Cross-Entropy and Kullback-Leibler Divergence | Implementación anterior conservada. | Densidades continuas e inferencia/calibración. |
| 72 | Fokker-Planck Equations | Implementación anterior conservada. | PDE no lineales de dimensión mayor y estudios de convergencia. |
| 73 | Quantum Coherence Tensor in Hilbert Spaces | Implementación anterior conservada. | Tensor de coherencia en espacio de Hilbert arbitrario y hardware cuando se exija ejecución física. |
| 74 | Particle Filter with Genetic-Algorithm Resampling | Implementación anterior conservada. | Mutación/cruce genéticos con sesgo de posterior explícito y justificado. |
| 75 | Spatiotemporal Capsule Networks | Implementación anterior conservada. | CapsNet entrenada, backbone de imágenes y dinámica temporal aprendida. |
| 76 | Modelador de Caminatas Aleatorias con Memoria a Largo Plazo | Implementación anterior conservada. | Ajuste de procesos estocásticos y calibración a largo plazo. |
| 77 | Resolvedor de Ecuaciones de Navier-Stokes para Datos Volumétricos | Implementación anterior conservada. | Datos volumétricos 3D, validación de convergencia y cargas CFD reales. |
| 78 | Motor de Análisis de Fluctuaciones sin Tendencia (DFA) | Implementación anterior conservada. | Estimación de sesgo/intervalos de confianza y DFA multifractal. |
| 79 | Optimizador de Enjambres con Dinámica de Fluidos Cuánticos | Implementación anterior conservada. | PDE completa de fluido cuántico y QPU física si ese es el requisito. |
| 80 | Resolvedor de Control Hamiltoniano-Jacobi-Bellman | Implementación anterior conservada. | HJB estocástica/continua con discretización y fronteras validadas. |
| 81 | Compilador de Firmas Criptográficas Post-Cuánticas Basadas en Isogenias | Implementación anterior conservada. | Firma postcuántica basada en isogenias con generación de claves, firma y verificación; Vélu no es una firma. |
| 82 | Motor de Redes de Memoria a Corto y Largo Plazo con Compuertas Neuronales Informadas (p-LSTM) | Entrenamiento BPTT de LSTM peephole con pérdidas físicas declarativas y datos supervisados. | Entrenamiento y retropropagación LSTM, minimización de pérdida física y datasets. |
| 83 | Filtro de Descomposición en Valores Singulares Dinámicos de Gran Escala | SVD Jacobi sobre matriz directa y subespacio derecho incremental con memoria acotada y cota de compresión. | SVD incremental/fuera de memoria y completa, estimaciones de convergencia y condición. |
| 84 | Motor de Procesos de Decisión de Markov de Horizonte Infinito | Corrección: política greedy calculada sobre los valores efectivamente devueltos. | MDP generales no descontados o continuos. |
| 85 | Resolvedor de Optimización Convexa Mediante Métodos de Punto Interior | Corrección: multiplicadores duales y brecha primal-dual real; límite de iteraciones explícito. | Optimización convexa multivariante/conos/QP/SOCP/SDP y certificados de precisión. |
| 86 | Motor de Análisis de Sincronización de Fases en Redes Complejas | Implementación anterior conservada. | Identificación de acoplamientos, sistemas ruidosos y pruebas de estabilidad asintótica. |
| 87 | Modelador de Procesos de Puntos de Hawkes Auto-Excitados | Hawkes multivariante: verosimilitud, ajuste mu/alpha/beta, simulación y errores estándar cuando son identificables. | Ajuste de parámetros, Hawkes multivariante y validación de incertidumbre. |
| 88 | Resolvedor de Teoría de Juegos de Campo Medio con Restricciones de Frontera | Implementación anterior conservada. | PDE de juegos de campo medio con fronteras generales y garantía de convergencia. |
| 89 | Compilador de Criptografía Homomórfica Totalmente Funcional (FHE) | Implementación anterior conservada. | FHE con bootstrapping, profundidad renovable, parámetros adecuados y gestión de claves. |
| 90 | Motor de Geometría Diferencial de Espacios de Parámetros | Implementación anterior conservada. | Variedades de parámetros/datos arbitrarias. |
| 91 | Motor de Ergodicidad en Sistemas No Lineales | Implementación anterior conservada. | Prueba de ergodicidad del mapa no lineal continuo, más allá de aproximación Ulam finita. |
| 92 | Evaluador de Estabilidad Estocástica de Lyapunov | Implementación anterior conservada. | Desigualdades de Lyapunov estocásticas no lineales generales. |
| 93 | Validador de Consistencia por Consensus Raft Criptográfico Local | Implementación anterior conservada. | Elección Raft real, replicación, particiones de red y vivacidad. |
| 94 | Motor de Geometría de la Información de Chentsov | Implementación anterior conservada. | Espacios de medida generales y prueba formal del teorema de unicidad. |
| 95 | Compilador de Pruebas de Conocimiento Cero No Interactivas (zk-SNARKs) de Ejecución | Implementación anterior conservada. | zk-SNARK general y compilador de ejecución; Schnorr de logaritmo discreto no es SNARK. |
| 96 | Filtro de Kalman de Raíz Cuadrada por Factorización Cholesky | Modelo multivariable variable en el tiempo, canales ausentes, factores semidefinidos y ruido correlacionado. | Modelos variables en el tiempo, canales ausentes, filtros mal condicionados/singulares y benchmarks independientes. |
| 97 | Motor de Inferencia Variacional con Restricciones Causal-Económicas | Implementación anterior conservada. | Descubrimiento causal, distribuciones generales y convergencia global. |
| 98 | Resolvedor de Sistemas Dinámicos No Lineales con Bifurcación de Hopf | Implementación anterior conservada. | Detección general de Hopf. |
| 99 | Motor de Campos Aleatorios Condicionales (CRF) Estocásticos | Entrenamiento de potenciales CRF sobre grafos finitos; mismo núcleo explícito que #49. | CRF de grafos arbitrarios y aprendizaje de modelos. |
| 100 | Compilador Criptográfico de Firmas de Invariancia de Estado Estricta | Implementación anterior conservada. | Compilador general, robustecimiento adversarial y revisión de seguridad. |

Los límites concretos de cada ampliación están en `docs/MATRIZ_100_MOTORES.json` y `docs/API_V11.md`. Ningún pendiente de la tabla se considera cerrado solo por haber modificado ese ID.

## Límites que necesitan una formulación precisa

- #01/#40: una garantía para cualquier programa arbitrario exige restringir lenguaje y propiedades; no puede inferirse a partir de explorar modelos finitos.
- #07: reconstrucción estadística de estados pasados no equivale a inversión física del tiempo.
- #12: ninguna prueba sobre escenarios suministrados garantiza aislar sucesos desconocidos no modelados.
- #58: identificación ciega no lineal requiere supuestos identificadores; la propia captura lo advierte.
- #81/#89/#95: siguen faltando firma por isogenias, FHE con bootstrapping y zk-SNARK de ejecución. No se sustituyen por ML-KEM, cifrado parcial ni Schnorr.
- No se añade auditoría o certificación externa como requisito para programar los motores. Tampoco se afirma que tales revisiones se hayan realizado.


## Actualización v17 (sin cierre de alcance)

- #89: el ejecutable Rust elimina los modos heredados de bits y sumandos privados en argumentos CLI; solo stdin recibe valores privados. El adaptador JS suprime la salida no confiable de subprocesos fallidos para evitar reflejar secretos en excepciones. Pruebas Rust nuevas para rechazar esos modos: requieren ejecutar Cargo.
- #95: se exige una línea final de éxito exacta del CLI en la verificación, no la presencia de `OK!` como subcadena. Se pueden fijar SHA-256 externos de `circom` y `snarkjs`; errores de herramientas no incluyen stdout/stderr. Pruebas negativas verificadas en JS no equivalen a generar ni comprobar una prueba Groth16 real.
- #81: sin cambio; sigue pendiente la firma post-cuántica basada en isogenias. Los restantes límites del alcance original permanecen en la matriz de 100 motores.
