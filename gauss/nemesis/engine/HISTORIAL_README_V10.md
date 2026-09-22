# NEMESIS — 100 interfaces ejecutables de investigación (NO es el proyecto completo)

**Estado comprobable:** 100 nombres conservados; #01 CTL/DSL y 99 entradas en `MOTOR_REGISTRY`. Los módulos #81, #89 y #95 ahora ejecutan **primitivas genuinas pero mucho más limitadas que los motores originalmente pedidos**. No están terminados como firmas postcuánticas, FHE ni zk-SNARKs generales. Tampoco se ha completado el alcance amplio de los otros 97 ni la integración con Nexus. Este paquete no es apto para producción criptográfica.

## Precisión obligatoria sobre los tres pendientes

| ID original | Código nuevo y demostración | ¿Cumple el motor original? |
|---|---|---|
| **81 — Firma postcuántica de isogenias** | `src/motors/isogeny-2.mjs`: isogenia Vélu de grado 2 sobre curvas elípticas finitas pequeñas con verificación de imagen y kernel. | **NO.** No genera ni verifica firmas y no ofrece seguridad postcuántica. |
| **89 — FHE** | `src/motors/leveled-he.mjs`: esquema de enteros inspirado en DGHV para bits, permite AND, XOR, OR, NAND, NOT sobre ciphertexts; límite explícito de ruido. | **NO.** Cifrado simétrico *somewhat homomorphic*, sin bootstrapping, auditoría ni profundidad arbitraria. |
| **95 — zk-SNARK de ejecución** | `src/motors/linear-execution-nizk.mjs`: prueba no interactiva estilo Schnorr/Fiat–Shamir de conocimiento de entradas ocultas comprometidas que satisfacen una expresión afín módulo un primo. Verificación independiente y rechazo de alteraciones. | **NO.** La prueba crece con los inputs y no prueba circuitos de ejecución arbitrarios ni implementa un zk-SNARK general. |

**No usar estos tres módulos para custodiar secretos, firmar documentos ni certificar la ejecución de software.** Son experimentos matemáticos con contratos delimitados. El código de los tres utiliza exclusivamente las primitivas criptográficas nativas de Node.js; no requiere descargar dependencias.

## Ejecución local

```sh
node --version                # Node.js >=20; probado en Node 22
npm test                      # no requiere npm install ni red
node cli.mjs motor examples/motor-63.json 63
node cli.mjs motor examples/motor-84.json 84
node cli.mjs motor examples/motor-93.json 93
node cli.mjs motor examples/motor-100.json 100
node cli.mjs motor examples/motor-81.json 81
node cli.mjs motor examples/motor-89.json 89
node cli.mjs motor examples/motor-95.json 95
node cli.mjs pipeline examples/pipeline-64-to-63.json
node cli.mjs verify examples/safe-finite-system.json
```

Importación programática:

```js
import { runMotor, MOTOR_REGISTRY, verifyFiniteSystem } from './src/index.mjs';
const report = runMotor('71', { p:[0.5,0.5], q:[0.5,0.5] });
console.log(report.kl); // 0
```

Los IDs con dos dígitos son cadenas (`'61'`); el motor 100 utiliza `'100'`. Para #01 se usa `verifyFiniteSystem` o `verifyFiniteProgram`, no `runMotor('01')`. `runMotor('81'|'89'|'95', ...)` ejecuta las primitivas acotadas descritas arriba: **no** constituye el motor criptográfico de su nombre original. Cada ID 61–100 tiene JSON de ejemplo. El CLI sale con código 1 ante verificaciones falsas y estados fallidos reconocidos. El pipeline local acepta un DAG JSON ordenado, referencias `{$ref:{taskId,path}}`, rechaza dependencias futuras, IDs ausentes y pruebas negativas, y registra SHA-256 de entradas/salidas. **Es composición local, NO integración con Nexus**.

## Alcance de la entrega nueva

- **61–80:** privacidad local por respuesta aleatorizada, atención temporal causal, DMD, POMDP finito, optimización clásica con momento complejo, cópula Clayton, diagnóstico de cointegración, juegos evolutivos, demostración LWE insegura, homología de flujo, divergencias, Fokker–Planck, tensor de Pauli de un qubit, filtro de partículas, cápsulas *forward*, caminatas con memoria, Navier–Stokes 3D discretizado, DFA, QPSO y HJB finito.
- **82–88:** inferencia p-LSTM, SVD truncada, MDP de horizonte infinito descontado, QP convexo con punto interior, Kuramoto, verosimilitud de Hawkes y juego de campo medio con frontera.
- **90–94 y 96–100:** Fisher de modelo logístico, Ulam aproximado, Lyapunov aleatorio diagonal, validador local de evidencia Raft firmada, contracción de Chentsov, Kalman escalar factorizado, VI con varios momentos, bifurcación Hopf, entrenamiento limitado CRF y certificación de transición con hash enlazado.

**Seguridad:** #69 NO ES SEGURO: sus parámetros LWE son didácticos. #81, #89 y #95 contienen primitivas matemáticas pero **NO** los sistemas criptográficos prometidos originalmente. Las firmas Ed25519 prueban que una clave firmó unos bytes, no que los datos de origen sean verdaderos. Las claves privadas de ejemplos criptográficos se generaron temporalmente durante las pruebas y **no se empaquetan**; los ejemplos contienen únicamente firmas y claves públicas.

**Validación:** `test/` tiene pruebas propias, de integración, adversariales, numéricas y de regresión anteriores. `evidence/test-log.txt` captura la ejecución completa actual; `evidence/SHA256SUMS.txt` solo permite comprobar integridad de archivos. Los hashes no son pruebas formales de correctitud.

La documentación previa 01–60 está archivada bajo `HISTORIAL_*` para trazabilidad; contiene cifras históricas y no debe tratarse como estado actual. Consulte `ALCANCE_Y_ESTADO.md` para el estado individual de los 100 motores.
