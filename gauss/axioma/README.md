# AXIOMA — banco independiente de verificación matemática de Nexus

AXIOMA contrasta **resultados de GAUSS con cálculos de referencia separados**; no presume precisión matemática global. Este corte contiene **60 operadores exactos de 1,000** y deja **940 NO EVALUADOS por AXIOMA**. Cobertura, casos matemáticos correctos y rechazo de entradas inválidas son métricas distintas. Los resultados se atribuyen al SHA de la ejecución de CI, nunca se presumen a partir de la documentación.

## Ejecutar

Desde la raíz del repositorio con Node 24:

```sh
node --test gauss/tests/precision-bank-finite-polynomials-v1.test.mjs gauss/tests/axioma-permutations-v1.test.mjs gauss/tests/axioma-number-theory-v1.test.mjs gauss/tests/axioma-finite-graphs-v1.test.mjs
node gauss/axioma/run.mjs > /tmp/axioma-report.json
```

El segundo comando imprime un JSON reproducible por suite y operador con entradas válidas, fallos, entradas inválidas y hashes SHA-256 de entradas + resultados esperados. Sale con código distinto de cero ante discrepancias o aceptación indebida de entradas inválidas. No escribe durante las pruebas en el árbol del repositorio.

## Alcance (objetivos comprobables mediante el reporte)

| Suite | Operadores únicos | Casos válidos | Entradas inválidas | Referencia independiente |
| --- | ---: | ---: | ---: | --- |
| Polinomios sobre cuerpos primos | 12 | 1,200 | 36 | Aritmética BigInt modular, monomios y potencias |
| Permutaciones finitas | 25 | 2,500 | 75 | Enumeración completa de S_n para 1 ≤ n ≤ 6 |
| Teoría de números exacta | 11 | 1,100 | 33 | Enumeración de divisores, residuos, potencias BigInt, fracciones y ternas; testigos diofánticos por sustitución |
| Grafos finitos exactos | 12 | 1,200 | 36 | Enumeración directa de vértices, caminos, ciclos, coloraciones y subconjuntos de aristas |
| Total, sin operadores repetidos | **60/1,000 (6%)** | **6,000** | **180** | Contadores de fallos y rechazos separados |

El runner falla si cambia el denominador de 1,000, falta un operador, se duplica un ID, hay discrepancias o se acepta una entrada malformada. Las pruebas incorporan implementaciones intencionalmente defectuosas para comprobar que AXIOMA detecta fallos. Cuando pueden existir múltiples testigos correctos (por ejemplo, camino hamiltoniano, clique, conjunto dominante, matching o solución diofántica), se verifica su validez y optimalidad o la condición de existencia, sin exigir un testigo idéntico al de GAUSS.

## Lote de 200 operadores nuevos

El lote posterior a los 37 iniciales tiene objetivo de **200 operadores nuevos**. En esta rama se han incorporado **23 de los 200**; **177 permanecen pendientes de referencias independientes, casos, prueba de entradas inválidas y ejecución**. No se marca terminado este lote ni se atribuyen pruebas de GAUSS a AXIOMA. El orden 38–237 es ordinal de cobertura y no corresponde necesariamente al sufijo numérico de los IDs de GAUSS.

## Límites de la interpretación

- **Cobertura** = operadores únicos evaluados / 1,000; no equivale a precisión general.
- **Conformidad observada** = casos válidos correctos / casos válidos ejecutados dentro de los límites explícitos; la tasa de rechazo inválido tiene otro denominador.
- Semillas deterministas públicas, 100 casos por operador y oráculos de código visible: no existe aún un conjunto externo ciego. La independencia de implementación no equivale a una demostración universal ni a independencia estadística de los casos.
- Los 940 operadores fuera de esta evaluación no son considerados éxitos ni errores. Tampoco se mide redondeo, estabilidad, condicionamiento, precisión arbitraria, rendimiento ni uso de QPU físico. Los operadores aproximados requieren tolerancias preestablecidas y métricas de error o residuales por problema.

Esta rama parte del banco en `507d09fe3be45e6dde572e9306e2aab280930eed`, permanece separada de `main` y no modifica apps de clientes ni despliegues. La validación debe atribuirse al SHA exacto de cada ejecución, no a uno anterior.
