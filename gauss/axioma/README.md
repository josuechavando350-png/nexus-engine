# AXIOMA — banco independiente de verificación matemática de Nexus

AXIOMA contrasta **resultados de GAUSS con cálculos de referencia separados**; no presume precisión matemática global. Este primer corte cubre **37 operadores exactos de 1,000** y deja **963 NO EVALUADOS por AXIOMA**. El avance de cobertura, la proporción de casos correctos y el rechazo de entradas inválidas son métricas distintas.

## Ejecutar

Desde la raíz del repositorio con Node 24:

```sh
node --test gauss/tests/precision-bank-finite-polynomials-v1.test.mjs gauss/tests/axioma-permutations-v1.test.mjs
node gauss/axioma/run.mjs > /tmp/axioma-report.json
```

El segundo comando imprime un JSON reproducible por suite y operador con entradas válidas, fallos, entradas inválidas y hashes SHA-256 de entradas + resultados esperados. Sale con código distinto de cero ante discrepancias o aceptación indebida de entradas inválidas. No escribe durante las pruebas en el árbol del repositorio.

## Alcance medido (v1)

| Suite | Operadores únicos | Casos válidos | Entradas inválidas | Criterio |
| --- | ---: | ---: | ---: | --- |
| Polinomios sobre cuerpos primos | 12 | 1,200 | 36 | Coincidencia exacta de enteros/arreglos con referencias BigInt modulares separadas |
| Permutaciones finitas | 25 | 2,500 | 75 | Coincidencia exacta con enumeración completa del grupo simétrico S_n para 1 ≤ n ≤ 6 |
| Total (sin operadores repetidos) | **37/1,000 (3.7%)** | **3,700** | **111** | Cada fallo y rechazo se cuenta en su propio denominador |

Los recuentos de éxito del cuadro son objetivos de la prueba, no resultados asumidos: el reporte de ejecución es la evidencia. El runner falla si cambia el denominador fijo de 1,000, falta un operador, se duplica un ID, hay discrepancias o se acepta una entrada malformada. Las pruebas incorporan implementaciones intencionalmente defectuosas para comprobar que AXIOMA detecta fallos.

## Cómo evitar una cifra de precisión engañosa

- **Cobertura** = operadores únicos evaluados / 1,000; no equivale a precisión.
- **Conformidad observada** = casos válidos correctos / casos válidos ejecutados, únicamente para los operadores y límites declarados. **Rechazo de entrada inválida** se calcula por separado.
- Los dos conjuntos utilizan semillas deterministas públicas y **100 casos por operador**. Los casos no están ocultos ni constituyen un conjunto externo reservado; una futura evaluación ciega requiere otra muestra y otro proceso.
- En permutaciones se enumeran todas las permutaciones de tamaño hasta seis para rank/unrank, sucesores y predecesores, centralizadores y clases de conjugación. Las demás referencias calculan directamente sus definiciones sobre los mismos tamaños. La suite de polinomios usa aritmética BigInt, expansión por monomios y evaluación por potencias. Los referentes no importan algoritmos de GAUSS, aunque comparten las definiciones matemáticas de los problemas.
- Las entradas inválidas verifican validación, **no** se suman al porcentaje de resultados matemáticos válidos. Los 963 operadores sin esta evaluación no se consideran éxitos ni errores.
- Este corte no mide redondeo, estabilidad numérica, condicionamiento, precisión arbitraria, rendimiento, uso de QPU físico ni fiabilidad fuera de los límites de entrada declarados. Los operadores aproximados necesitan tolerancias preestablecidas y reporte de errores absoluto/relativo o residuos por problema, antes de calcular su conformidad.

La rama del banco se basa en el SHA de integración GAUSS `41c5530ead7e970c7917687e0f994309de268caf`, permanece separada de `main` y no modifica apps de clientes ni despliegues. La validación de CI debe atribuirse al SHA exacto de cada ejecución, no a un resultado anterior.
