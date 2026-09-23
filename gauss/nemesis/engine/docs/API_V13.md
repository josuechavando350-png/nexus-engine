# Némesis v13: contratos, resultados y límites

Todos los modos descritos están conectados a `runMotor` y al CLI. Contrato:
`{ "action": "nombre", "payload": { ... } }`. Los contratos anteriores sin
`action` conservan sus implementaciones. Los datos de las pruebas son sintéticos.

## #51: convergencia y cota de error de campo medio

El resultado conserva `residual` (cambio entre iteraciones) y añade
`fixedPointResidual = ||m - tanh(h + Jm)||∞`.
`converged` se calcula con este último residuo sobre los valores devueltos.
Si `L = max_i sum_j |J_ij| < 1`, `contractionCertificate` proporciona
`infinityNormErrorBound = fixedPointResidual / (1-L)`.
La condición de contracción asegura un único punto fijo del modelo factorizado.
La cota se evalúa en coma flotante; no constituye una prueba con aritmética de
intervalos, ni demuestra exactitud de las marginales de Ising.
Si L≥1, la cota es `null` y se declara que la condición no está establecida.

Corrección de integración: cualquier `converged:false` produce código de salida
1 en el CLI y bloquea el pipeline. Antes solo se comprobaba esta señal para #84.

## #66: cópula Clayton multivariante

| Acción | Payload | Resultado principal |
|---|---|---|
| `evaluate` | `u`, `theta` | CDF, logdensidad, densidad y coeficientes de dependencia de cola |
| `sample` | `theta`, `dimension`, `count`, `seed` | Muestras con márgenes uniformes mediante fragilidad gamma |
| `fit` | `samples`, opcionales `maxTheta`, `tolerance` | Parámetro ajustado, logverosimilitud, convergencia y condición de frontera |
| `calibrate` | `samples`, `theta`, `thresholds` | Frecuencias conjuntas inferiores, predicción y bandas Wilson puntuales |

`theta` admite 0 (independencia) o [0.0001,20]; dimensiones de 2 a 32.
Las coordenadas de densidad y datos deben estar estrictamente dentro de (0,1).
La densidad se evalúa en logaritmos; cuando su exponencial desborda, `density`
vale el texto `Infinity` y se conserva `logDensity` finita.

El ajuste usa una malla logarítmica de 65 parámetros seguida por búsqueda áurea
en el intervalo vecino al mejor punto. Incluye explícitamente la independencia
y los extremos como candidatos. `CONVERGED` significa que se alcanzó la
tolerancia de ese intervalo; no certifica optimalidad global.
Los límites incluyen 100000 escalares para ajuste y 1000000 para muestreo.

La calibración necesita observaciones independientes y separadas de las usadas
para ajustar. Las bandas son binomiales puntuales al 95%; no corrigen múltiples
comparaciones, dependencia temporal ni incertidumbre por estimación marginal.
La API no puede verificar que el llamador haya separado los datos.
`examples/v13/pipeline-copula-held-out.json` realiza esa separación con dos
muestras sintéticas de semillas diferentes y conecta muestreo → ajuste →
evaluación sobre observaciones reservadas.

La API antigua ya admitía CDF Clayton multivariante; v13 añade densidad,
muestreo, ajuste y evaluación empírica. No se atribuye como nueva esa CDF.

## #70: homología incremental de flujos

`action:'filtered'`: `{batches:[[{vertices:[0],value:0},...],...],
maxSimplices?:10000,maxOperations?:10000000}`.
El estado conserva las columnas reducidas de la matriz frontera sobre F2.
Cada lote reduce únicamente las columnas nuevas. Se comprueban caras, tiempos
no decrecientes, duplicados y presupuestos antes de confirmar el cambio.
Un lote fallido deja el estado anterior intacto.

La API directa `createIncrementalHomology(options)` expone `append(batch)` y
`snapshot()`. Los resultados no permiten modificar el estado interno.
Cada actualización informa `newColumnsReduced` y `newOperations`.
La capacidad es 10000 símplices, dimensión máxima 9, hasta 2000000 entradas
reducidas y 100000000 operaciones acumuladas por instancia.

`action:'points'`: `{events:[{time:0,point:[x,y,z]},...],radius:1,
maxHomology:2,maxOperations?:10000000}`.
Construye incrementalmente los nuevos cliques inducidos por cada punto a un
radio fijo. La filtración es **tiempo de llegada**, no radio. Admite hasta
256 puntos, 64 coordenadas y H0–H4, sujeto a los presupuestos de complejidad.
Se incluyen cofaces de dimensión H+1 para calcular muertes en la dimensión H.

`bars` usa intervalos `[birth,death)`; `death:null` es supervivencia al final
observado, no garantía de persistencia futura. Se conservan intervalos nulos.
No hay eliminación, ventana deslizante ni homología zigzag. El modo anterior
sin `action` sigue recalculando persistencia en radio sobre prefijos pequeños.

## #71: divergencias de densidades continuas

`action:'gaussian'`: `{p:{mean:[...],covariance:[[...]]},q:{...},base?:Math.E}`.
Calcula entropía diferencial de p, entropía cruzada y KL(p||q) analíticas,
mediante factores Cholesky y resoluciones triangulares, sin invertir matrices.
Dimensión 1–64; covarianzas simétricas definidas positivas. Rechaza matrices
singulares y desbordamientos. No supone normalidad de datos desconocidos.

`action:'piecewise'`: `{p:{edges:[...],density:[...]},q:{...},base?:Math.E}`.
Las densidades constantes por tramo deben integrar uno y son cero fuera de
sus bordes. Usa la partición conjunta, respetando anchuras; calcula entropía
diferencial, entropía cruzada, KL y Jensen–Shannon por integración de cada tramo.
Si p tiene masa donde q es cero, KL y entropía cruzada son el texto `Infinity`.
Jensen–Shannon permanece finita. Hasta 4096 tramos por densidad.

## Fuentes técnicas y alcance

- Clayton y muestreo: https://www2.math.ethz.ch/finance/summerschool/partE.pdf
- Referencia de implementación: https://github.com/cran/copula/blob/master/R/claytonCopula.R
- KL gaussiana: https://statproofbook.github.io/P/mvn-kl
- Reducción de homología: https://math.uchicago.edu/~shmuel/AAT-readings/Data%20Analysis%20/persistence1.pdf

Se revisó también `Especificacion_Absoluta_Nexus_Gauss(1).pdf` aportado por el
usuario. Establece ejecución local y estados de certeza, pero no contiene
contratos completos ni criterios comprobables para cerrar los 100 motores.
Su ejemplo que devuelve PROVEN al superar un umbral de fricción no constituye
una demostración matemática. No se añade ese criterio al código de Némesis.

Estos cambios no cierran los requisitos restantes de los 100 motores.
La matriz conserva cada pendiente original y añade los pendientes actuales
de los IDs modificados. El backend Rust #89 continúa sin ejecución local
acreditada; #81 y #95 tampoco se presentan como criptosistemas terminados.
