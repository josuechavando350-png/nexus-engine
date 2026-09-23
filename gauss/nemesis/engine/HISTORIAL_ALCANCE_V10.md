# NEMESIS — entrega verificable, inventario original 01–100

**Estado: NO TERMINADO / NO CERTIFICADO PARA PRODUCCIÓN.** Se conservan los 100 nombres originales. Hay **100 interfaces con código ejecutable acotado** (#01 CTL/DSL; 99 entradas registradas para #02–100), pero #81, #89 y #95 solo cuentan con primitivas preparatorias: **NO cumplen sus especificaciones originales**. Los otros 97 tienen alcances acotados y tampoco deben equipararse al alcance irrestricto de sus títulos. Ninguna prueba valida seguridad criptográfica productiva, integración con Nexus o datos externos.

Las columnas **Alcance demostrado** declaran qué se puede ejecutar y qué NO significa el nombre científico. Las propuestas 81, 89 y 95 ahora tienen **primitivas acotadas explícitamente incompletas**: 2-isogenia sin firma, cifrado simétrico parcialmente homomórfico sin bootstrapping y argumento NIZK para expresiones afines. Las llamadas a sus IDs ejecutan esas primitivas, pero ninguna cumple el nombre científico original; no se simulan resultados de firmas/FHE/SNARKs.

| # | Propuesta original | Estado | Alcance demostrado / pendiente |
|---|---|---|---|
| 01 | Verificación Formal (Lógica de Autómatas) | ACOTADA | Modelo CTL y DSL finitos, no código JS/TS arbitrario |
| 02 | Inferencia Causal (Cálculo de Judea Pearl) | ACOTADA | DAG binario completo y conocido, sin aprendizaje estructural |
| 03 | Teoría de Juegos / Equilibrio de Nash (Montecarlo Masivo) | ACOTADA | Nash puro 2 jugadores 2–8 estrategias; mezcla interior 2x2 no degenerada |
| 04 | Optimización Cuántica Local (QAOA Simulator) | ACOTADA | Simulación QAOA ideal MaxCut <=8 vértices, hasta 4 capas, sin entrenamiento/hardware |
| 05 | Entropía de Shannon y Variables Ocultas | ACOTADA | HMM de número de estados conocido, aprendizaje local de parámetros y entropía |
| 06 | Caminatas Aleatorias Cuánticas | ACOTADA | CTQW adyacencia ponderada y Grover coin/discrete flip-flop en grafos no dirigidos <=12 vertices |
| 07 | Inversión Temporal (Kalman de Orden Superior) | ACOTADA | Kalman lineal Gaussian multivariado y RTS de intervalo fijo, dimension <=6 |
| 08 | Validador Lógico Invariable (Zero-Knowledge Proofs Coherentes) | ACOTADA | Pedersen en QR MODP14 y prueba de conocimiento de apertura; NO prueba de rango, circuito ni auditoria criptografica externa |
| 09 | Actualización Bayesiana Asíncrona Continua | ACOTADA | Bayes binario exacto con eventos condicionalmente independientes, deduplicacion y replay por tiempo |
| 10 | Programador de Agentes Espejo | ACOTADA | Dos Node worker_threads ejecutan FSM declarativa con comparacion de trazas, sin sandbox de codigo externo |
| 11 | Filtro de Sesgo de Confirmación Humana | ACOTADA | Condicionamiento bayesiano exacto de evidencia binaria en muestra seleccionada con propensiones conocidas; no diagnostico cognitivo |
| 12 | Motor de Aislamiento de Cisnes Negros | ACOTADA | VaR y CVaR exactos de pérdidas discretas finitas con probabilidades conocidas; no cubre cisnes negros no modelados |
| 13 | Motor de Sincronización de Relojes de Redes Complejas (Chronos Engine) | ACOTADA | Restricciones de diferencias de offsets enteros, cotas exactas, testigo de inconsistencia; no sincroniza relojes de red |
| 14 | Resolvedor de Lógica Difusa de Segundo Orden | ACOTADA | Logica difusa Godel finita con cuantificacion sobre universo explicito de interpretaciones; no logica general |
| 15 | Motor de Evolución Gramatical y Mutación de Código (Self-Healing Code) | ACOTADA | Busqueda exhaustiva acotada de 0-2 ediciones AST para expresiones enteras sobre ejemplos; no repara codigo fuente real |
| 16 | Calculador de Robustez Estructural | ACOTADA | Articulaciones, puentes y cortes mínimos s-t exactos en grafos simples no dirigidos <=12 nodos |
| 17 | Motor de Ontología de Dominio Cruzado | ACOTADA | Cierre transitivo de subclases/equivalencias, inferencia positiva y conflicto de tipos en ontología finita |
| 18 | Gestor de Fricción de Ingesta Inversa | ACOTADA | Plan reverse-ETL determinista sobre registros JSON <=256, CAS y aplicación transaccional solo en memoria |
| 19 | Motor de Ingesta de Dark Data | ACOTADA | Catálogo bytes UTF-8/base64 local <=256 KiB/documento, SHA-256, deduplicación y búsqueda exacta en texto declarado |
| 20 | Compilador de Contratos de Certeza Criptográfica | ACOTADA | Contrato declarativo de predicados numéricos, hash SHA-256 y atestación Ed25519 verificable de reporte aportado |
| 21 | Motor de Geometría de Información No-Riemanniana | ACOTADA | KL direccional, JS y variacion total en simplex finito; no geometria no riemanniana general |
| 22 | Resolvedor de Atractores de Lorenz de Alta Dimensión | ACOTADA | ODE Lorenz-96 N=4..128 integrado RK4; estimador Lyapunov finito de una perturbacion, no prueba de atractor |
| 23 | Filtro de Kalman Ensamblado de Alta Dimensión | ACOTADA | EnKF estocastico lineal gaussiano con ensamble <=256, semilla y covarianzas definidas positivas |
| 24 | Motor de Redes Neuronales Informadas por la Física (PINN) | ACOTADA | Red tanh de capa oculta fija con readout aprendido mediante residuos PDE; Poisson 1D condiciones Dirichlet |
| 25 | Simulador de Dinámica de Fluidos de Información | ACOTADA | Difusion Laplaciana conservativa en grafo no dirigido <=128 nodos bajo cota Euler explicita |
| 26 | Multilayer Stackelberg | ACOTADA | Induccion hacia atras 3 jugadores secuenciales juego finito de informacion perfecta |
| 27 | Persistent-homology TDA | ACOTADA | Homologia persistente Vietoris-Rips H0/H1 sobre <=16 puntos, filtracion a traves de triangulos en Z2 |
| 28 | Causal inverse reinforcement learning | ACOTADA | MaxEnt IRL tabular horizonte finito con dinamicas interventionales aportadas, no descubrimiento causal |
| 29 | Multivariate transfer entropy | ACOTADA | Estimador plug-in de I(Xprev;Yactual\|Yprev,Zprev) categorico multivariado sin prueba de causalidad |
| 30 | Scenario-robust optimization | ACOTADA | Enumeracion exacta de decisiones discretas minimax costo y minimax arrepentimiento bajo escenarios y restricciones explicitos |
| 31 | Cryptographic local smart-contract compiler | ACOTADA | Compilador determinista de reglas de enteros a VM local con hash, guardias, aplicación in-memory, sin blockchain |
| 32 | Large-scale dynamic graphs | ACOTADA | Grafo no dirigido 1-10000 nodos, altas y bajas en memoria, componentes, grados y BFS recalculados |
| 33 | Empirical mode decomposition | ACOTADA | EMD de series finitas por cribado y envolventes lineales, reconstrucción numérica; no spline cúbico |
| 34 | Dynamic Bayesian networks | ACOTADA | Filtro forward exacto por enumeración de estados conjuntos binarios <=64, transición y emisión conocidas |
| 35 | Stochastic dynamic programming | ACOTADA | MDP tabular de horizonte finito, dinámica conocida, Bellman exacto en aritmética de coma flotante |
| 36 | Causal time series via convergent cross mapping | ACOTADA | CCM de series reales por embedding y proyección simplex, habilidad predictiva, NO prueba causal |
| 37 | Spatiotemporal random fields | ACOTADA | Muestreo de campo gaussiano finito con covarianza espacio-tiempo exponencial y Cholesky |
| 38 | Constrained particle swarms | ACOTADA | PSO estocástico reproducible con objetivo cuadrático y restricciones lineales; heurístico, sin optimalidad garantizada |
| 39 | Local homomorphic computing | ACOTADA | Paillier aditivo local con claves >=512 bits, aleatoriedad del SO; experimental, NO auditoría/seguridad producción |
| 40 | Formal verification of state invariants | ACOTADA | Prueba exhaustiva de invariantes inductivos Boolean DSL <=12 variables, contraejemplos alcanzables |
| 41 | Dynamic-network ergodicity | ACOTADA | P finite ≤128; communicating classes, period, Cesaro estimate |
| 42 | Lyapunov stability evaluation | ACOTADA | 1×1 or 2×2 discrete linear constant system; spectral test and numerical Lyapunov certificate |
| 43 | Byzantine replica consensus | ACOTADA | authenticated identities assumed; single-view quorum transcript only, no distributed protocol |
| 44 | Amari Fisher-Rao geometry | ACOTADA | categorical simplex Fisher metric and distance |
| 45 | Zero-knowledge execution proofs | ACOTADA | Schnorr/Fiat-Shamir sobre grupo QR MODP14 fijo; prueba relación logaritmo discreto, no ejecución arbitraria ni seguridad auditada |
| 46 | High-velocity square-root Kalman | ACOTADA | bounded multivariate Gaussian Kalman Joseph+Cholesky, no optimized QR |
| 47 | Causal-economic constrained variational inference | ACOTADA | categorical single linear moment I-projection; no causal structure learning |
| 48 | Nonlinear bifurcation systems | ACOTADA | logistic map finite-time Lyapunov and approximate periods |
| 49 | Stochastic CRF | ACOTADA | exact finite linear-chain CRF inference, fixed potentials, no training |
| 50 | Strict cryptographic invariance signatures | ACOTADA | Ed25519 signed state invariance claim under caller-owned trusted keys; no authenticity of measurements |
| 51 | Mean-Field Inference | ACOTADA | local factorized Ising coordinate ascent, not exact Ising inference |
| 52 | Strange Attractors and Spatiotemporal Chaos | ACOTADA | coupled logistic lattice and finite-time tangent growth |
| 53 | Ricci Curvature Tensor for Information Manifolds | ACOTADA | analytic Ricci tensor of interior categorical Fisher simplex |
| 54 | Invariant Group Kalman Filter (Lie Groups) | ACOTADA | scalar SO(2) local error angle Kalman, not arbitrary Lie groups |
| 55 | CNNs on Non-Euclidean Graphs | ACOTADA | one normalized symmetric graph convolution layer, supplied weights |
| 56 | Stochastic PDE (SPDE) | ACOTADA | 1D periodic stochastic heat Euler-Maruyama |
| 57 | Mean Field Games | ACOTADA | two-state finite-horizon congestion game fixed-point iteration; no convergence guarantee |
| 58 | Nonlinear ICA | ACOTADA | known invertible triangular nonlinear mix; no blind nonlinear ICA |
| 59 | Constrained Box Gaussian-Process Bayesian Optimizer | ACOTADA | RBF GP EI over supplied finite in-box candidates |
| 60 | Continuous-Time Stochastic Optimal Control | ACOTADA | scalar finite-horizon continuous stochastic LQR via numerical Riccati |
| 61 | Local Differential Privacy Ingestion Compiler | ACOTADA | Categorical k-ary randomized response with secure randomness and per-record epsilon; no budget manager across calls |
| 62 | Temporal-Attention Dynamic Graphs (TGAT) | ACOTADA | Causal time-filtered temporal attention forward on supplied features/weights; no learned TGAT |
| 63 | Dynamic Mode Decomposition (DMD) | ACOTADA | Least-squares linear DMD operator and finite forecast; no complete spectral eigenbasis or large-scale streaming |
| 64 | Partially Observable Markov Decision Processes (POMDP) | ACOTADA | Exact finite belief-tree Bellman planning for known POMDP <=6 states; horizon <=5 |
| 65 | Stochastic Gradient Descent with Quantum Momentum | ACOTADA | Classical quantum-inspired rotating-momentum optimizer for bounded quadratic; no quantum hardware |
| 66 | Archimedean Copulas for Multivariate Risks | ACOTADA | Clayton Archimedean copula CDF, Kendall tau and bivariate upper tail for supplied theta |
| 67 | Nonlinear Cointegration of Time Series | ACOTADA | Polynomial residual fit and ADF-like statistic without calibrated critical values or proof of cointegration |
| 68 | Stochastic Evolutionary Games | ACOTADA | Finite replicator-mutator expected dynamics with supplied payoff/mutation; not finite-population sampling |
| 69 | Lattice-Based Cryptography Storage Compiler | ACOTADA | Textbook 16-dimensional LWE Regev encryption/decryption educational ONLY: cryptographically insecure, NEVER protect real data |
| 70 | Persistent Homology of Dynamic Data Streams | ACOTADA | Exact bounded H0/H1 Rips persistence recomputed over append-only point stream |
| 71 | Cross-Entropy and Kullback-Leibler Divergence | ACOTADA | Discrete Shannon entropy, cross entropy, KL, JS with explicit infinite support mismatch |
| 72 | Fokker-Planck Equations | ACOTADA | Periodic 1D conservative finite-volume Fokker-Planck drift/diffusion with CFL guard |
| 73 | Quantum Coherence Tensor in Hilbert Spaces | ACOTADA | Qubit density matrix physicality, Bloch, purity and Pauli covariance tensor |
| 74 | Particle Filter with Genetic-Algorithm Resampling | ACOTADA | Seeded scalar bootstrap particle filter and optional heuristic genetic perturbation (bias disclosed) |
| 75 | Spatiotemporal Capsule Networks | ACOTADA | Finite capsule dynamic routing forward for supplied transforms, without training |
| 76 | Modelador de Caminatas Aleatorias con Memoria a Largo Plazo | ACOTADA | Finite power-law history self-interacting random walk with seeded RNG |
| 77 | Resolvedor de Ecuaciones de Navier-Stokes para Datos Volumétricos | ACOTADA | Bounded periodic 3D Navier-Stokes explicit finite differences and approximate Jacobi projection |
| 78 | Motor de Análisis de Fluctuaciones sin Tendencia (DFA) | ACOTADA | DFA1 window detrending and log-log scaling diagnostic, no statistical confidence guarantee |
| 79 | Optimizador de Enjambres con Dinámica de Fluidos Cuánticos | ACOTADA | Classical QPSO box-constrained quadratic objective heuristic; no quantum computation or global certificate |
| 80 | Resolvedor de Control Hamiltoniano-Jacobi-Bellman | ACOTADA | Monotone scalar finite-grid stochastic HJB finite horizon and reflecting boundaries |
| 81 | Compilador de Firmas Criptográficas Post-Cuánticas Basadas en Isogenias | **PRIMITIVA, NO FIRMA** | Vélu 2-isogeny over small prime fields with kernel and image checks. No key generation, signing, verification, security or viable isogeny-based signature scheme. |
| 82 | Motor de Redes de Memoria a Corto y Largo Plazo con Compuertas Neuronales Informadas (p-LSTM) | ACOTADA | Peephole LSTM forward inference with supplied weights, no training |
| 83 | Filtro de Descomposición en Valores Singulares Dinámicos de Gran Escala | ACOTADA | Finite iterative truncated SVD by power method/deflation; approximate not out-of-core |
| 84 | Motor de Procesos de Decisión de Markov de Horizonte Infinito | ACOTADA | Discounted finite-state infinite-horizon MDP value iteration with computable Bellman error bound |
| 85 | Resolvedor de Optimización Convexa Mediante Métodos de Punto Interior | ACOTADA | Strictly feasible convex quadratic program Newton log-barrier, not general conic optimization |
| 86 | Motor de Análisis de Sincronización de Fases en Redes Complejas | ACOTADA | Kuramoto phase network deterministic integration and order parameter |
| 87 | Modelador de Procesos de Puntos de Hawkes Auto-Excitados | ACOTADA | Known exponential Hawkes point-process likelihood and compensator, no parameter estimation |
| 88 | Resolvedor de Teoría de Juegos de Campo Medio con Restricciones de Frontera | ACOTADA | Two-state finite-horizon boundary-constrained mean-field game policy iteration with convergence status |
| 89 | Compilador de Criptografía Homomórfica Totalmente Funcional (FHE) | **PRIMITIVA, NO FHE** | Symmetric integer somewhat-homomorphic encryption for bits: AND/OR/XOR/NAND/NOT, conservative noise budget. No bootstrap, unbounded depth, public key or security audit. |
| 90 | Motor de Geometría Diferencial de Espacios de Parámetros | ACOTADA | Categorical logistic statistical manifold Fisher matrix and regularized natural gradient |
| 91 | Motor de Ergodicidad en Sistemas No Lineales | ACOTADA | Ulam finite partition logistic map Markov ergodicity approximation, not continuum proof |
| 92 | Evaluador de Estabilidad Estocástica de Lyapunov | ACOTADA | Exact mean-square Lyapunov condition for random diagonal finite matrices |
| 93 | Validador de Consistencia por Consensus Raft Criptográfico Local | ACOTADA | Offline Ed25519 authenticated local Raft transcript validator; NOT consensus protocol or signed replication transport |
| 94 | Motor de Geometría de la Información de Chentsov | ACOTADA | Finite categorical Chentsov Fisher contraction under stochastic channels |
| 95 | Compilador de Pruebas de Conocimiento Cero No Interactivas (zk-SNARKs) de Ejecución | **PRIMITIVA, NO SNARK GENERAL** | Fiat–Shamir generalized Schnorr NIZK of committed affine execution modulo q, 2–8 witnesses; not a succinct proof for arbitrary circuits. |
| 96 | Filtro de Kalman de Raíz Cuadrada por Factorización Cholesky | ACOTADA | Scalar factor-form Cholesky Kalman update; distinct bounded factor formulation of proposal #46 |
| 97 | Motor de Inferencia Variacional con Restricciones Causal-Económicas | ACOTADA | Categorical multi-moment KL variational projection with Newton optimizer; not causal discovery |
| 98 | Resolvedor de Sistemas Dinámicos No Lineales con Bifurcación de Hopf | ACOTADA | Supercritical Hopf normal-form RK4 flow and limit-cycle diagnostic |
| 99 | Motor de Campos Aleatorios Condicionales (CRF) Estocásticos | ACOTADA | Linear-chain CRF supervised unary-bias training with fixed supplied transition matrix |
| 100 | Compilador Criptográfico de Firmas de Invariancia de Estado Estricta | ACOTADA | Ed25519 signed and hash-linked state transition verification with context/epoch/replay binding; no source authentication |

Para completar los motores #81, #89 y #95 bajo sus **nombres originales**, revisar `CRITERIOS_PARA_TERMINAR.md`; estas condiciones continúan pendientes.

## Reglas de verificación y límites

- Pruebas deterministas y analíticas sobre entradas acotadas, más regresiones y pruebas de manipulación. `npm test` y ejemplos CLI verifican comportamiento observable, **no prueban ausencia de defectos**. Se rechazan entradas fuera de contrato o límites; no se certifican modelos explorados solo parcialmente.
- En #69 se implementa un cifrado **LWE educativo de dimensión 16 deliberadamente inseguro**; *no debe utilizarse para almacenar secretos*. En #81 hay una isogenia de grado 2 pero no firma; en #89 hay operaciones sobre ciphertexts pero no FHE ni bootstrapping; en #95 hay NIZK de cómputos afines acotados pero no zk-SNARK general. #43 y #93 no implementan un protocolo de consenso distribuido real; #45 y #08 no sustituyen #95.
- #61 emite informes aleatorizados de privacidad local con epsilon declarado. Un informe puede coincidir con el original y la privacidad no implica anonimato absoluto; se requieren gobernanza y composición entre consultas. #77 ejecuta un esquema numérico 3D aproximado con pruebas de proyección; no resuelve el problema matemático global de Navier–Stokes. #75 ejecuta *forward* de cápsulas con pesos suministrados, no entrenamiento.
- Para usar en Nexus se necesita definir contratos de integración, autorización, persistencia, autenticación de entradas, observabilidad, fallos y pruebas del proyecto consumidor. **No se modificó el repositorio de Nexus ni proyectos de Cano.**

## Reproducción

```sh
node --version   # Node >= 20
npm test
node cli.mjs motor examples/motor-63.json 63
node cli.mjs motor examples/motor-84.json 84
node cli.mjs motor examples/motor-93.json 93
node cli.mjs motor examples/motor-100.json 100
node cli.mjs pipeline examples/pipeline-64-to-63.json
node cli.mjs motor examples/motor-81.json 81  # isogenia; NO firma postcuántica
node cli.mjs motor examples/motor-89.json 89  # partially HE; NO FHE
node cli.mjs motor examples/motor-95.json 95  # NIZK afín; NO zk-SNARK general
```

Ejemplos disponibles como `examples/motor-N.json` para todos los IDs entre 61 y 100; el #01 usa `verify` y `program`. Los archivos anteriores 01–60 están conservados. Las pruebas de regresión verifican el rechazo de IDs fuera del inventario como 101. Los documentos con prefijo `HISTORIAL_` son **instantáneas anteriores a este lote, no describen el estado actual**.
