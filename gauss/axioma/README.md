# AXIOMA — banco independiente de verificación matemática de Nexus

AXIOMA contrasta **resultados de GAUSS con cálculos de referencia separados**; no presume precisión matemática global. Este corte de trabajo contiene **48 operadores exactos de 1,000** y deja **952 NO EVALUADOS por AXIOMA**. El avance de cobertura, la proporción de casos correctos y el rechazo de entradas inválidas son métricas distintas. Los números de éxito de abajo son expectativas del código de pruebas: la evidencia real es el reporte de ejecución y su SHA de CI.

## Ejecutar

Desde la raíz del repositorio con Node 24:

```sh
node --test gauss/tests/precision-bank-finite-polynomials-v1.test.mjs gauss/tests/axioma-permutations-v1.test.mjs gauss/tests/axioma-number-theory-v1.test.mjs
node gauss/axioma/run.mjs > /tmp/axioma-report.json
```

El segundo comando imprime un JSON reproducible por suite y operador con entradas válidas, fallos, entradas inválidas y hashes SHA-256 de entradas + resultados esperados. Sale con código distinto de cero ante discrepancias o aceptación indebida de entradas inválidas. No escribe durante las pruebas en el árbol del repositorio.

## Alcance medido (corte en desarrollo)

| Suite | Operadores únicos | Casos válidos | Entradas inválidas | Criterio |
| --- | ---: | ---: | ---: | --- |
| Polinomios sobre cuerpos primos | 12 | 1,200 | 36 | Coincidencia exacta con referencias BigInt modulares separadas |
| Permutaciones finitas | 25 | 2,500 | 75 | Coincidencia exacta con enumeración completa de S_n para 1 ≤ n ≤ 6 |
| Teoría de números exacta | 11 | 1,100 | 33 | Divisores enumerados, residuos, potencias modulares BigInt, enumeración de fracciones/triples e identidad de Bézout verificada por sustitución |
| Total (sin operadores repetidos) | **48/1,000 (4.8%)** | **4,800** | **144** | Cada fallo y rechazo se cuenta en su propio denominador |

El runner falla si cambia el denominador fijo de 1,000, falta un operador, se duplica un ID, hay discrepancias o se acepta una entrada malformada. Las pruebas incorporan implementaciones intencionalmente defectuosas para comprobar que AXIOMA detecta fallos. En el operador diofántico se verifica una solución por sustitución y la condición de existencia; los testigos matemáticamente equivalentes no necesitan tener los mismos coeficientes.

## Lote de 200 operadores nuevos

El lote siguiente al corte inicial de 37 tiene objetivo de **200 operadores nuevos**, pero **solo 11 están incorporados** en esta rama de trabajo. Quedan **189 del lote pendientes de referencias independientes, pruebas y ejecución**. Un archivo existente en el inventario de 1,000 de GAUSS no cuenta como verificado por AXIOMA por sí solo. El orden 38–237 es un ordinal de cobertura, no una promesa de correspondencia con los sufijos de ID de GAUSS.

## Cómo evitar una cifra de precisión engañosa

- **Cobertura** = operadores únicos evaluados / 1,000; no equivale a precisión.
- **Conformidad observada** = casos válidos correctos / casos válidos ejecutados, únicamente para los operadores y límites declarados. **Rechazo de entrada inválida** se calcula por separado.
- Los conjuntos utilizan semillas deterministas públicas y **100 casos por operador**. Los casos no están ocultos ni constituyen un conjunto externo reservado; una futura evaluación ciega requiere otra muestra y otro proceso.
- En permutaciones se enumeran las permutaciones de tamaño hasta seis para rank/unrank, sucesores y predecesores, centralizadores y clases de conjugación; el resto verifica definiciones. La suite de polinomios usa BigInt y expansión por monomios. La suite de teoría de números contrasta factorización con enumeración de divisores, reciprocidad con residuos y parametrización pitagórica con búsqueda de ternas. Los referentes no importan algoritmos de GAUSS, aunque comparten las definiciones matemáticas de los problemas.
- Las entradas inválidas verifican validación, **no** se suman al porcentaje de resultados matemáticos válidos. Los 952 operadores sin esta evaluación no se consideran éxitos ni errores.
- Este corte no mide redondeo, estabilidad numérica, condicionamiento, precisión arbitraria, rendimiento, uso de QPU físico ni fiabilidad fuera de los límites de entrada declarados. Los operadores aproximados necesitan tolerancias preestablecidas y reporte de errores absoluto/relativo o residuos por problema, antes de calcular su conformidad.

Esta rama de trabajo parte del banco en `507d09fe3be45e6dde572e9306e2aab280930eed`, permanece separada de `main` y no modifica apps de clientes ni despliegues. La validación de CI debe atribuirse al SHA exacto de cada ejecución, no a un resultado anterior.
