# AXIOMA — banco independiente de verificación matemática de Nexus

AXIOMA compara los operadores registrados de GAUSS con referencias matemáticas implementadas por separado. El tercer lote de este PR añade **300 referencias para operadores distintos** a los 437 anteriores, con objetivo de **737/1,000 (73.7% de cobertura)**. Los **263 restantes no se evalúan por AXIOMA**. Cada cifra de aciertos debe respaldarse con un informe ejecutado y las comprobaciones de CI del SHA exacto; cobertura no significa precisión universal.

## Ejecución reproducible

Desde la raíz del repositorio, con Node 24:

```sh
node --test gauss/tests/precision-bank-finite-polynomials-v1.test.mjs gauss/tests/axioma-*.test.mjs
node gauss/axioma/run.mjs > /tmp/axioma-report.json
bash walle/adapters/gauss.sh
```

El reporte enumera cada ID único, casos válidos acertados o fallidos, entradas inválidas rechazadas o indebidamente admitidas y el digest SHA-256 reproducible de cada suite. `runAxioma` impide duplicar operadores y comprueba los denominadores. Los tests introducen resultados falsos y aceptación permisiva de entradas malformadas: ambas modificaciones deben detectarse.

## Tercer lote: doce bancos de 25

| Referencias independientes | Familia GAUSS y rango | Operadores | Casos válidos | Inválidos |
| --- | --- | ---: | ---: | ---: |
| Secuencias enteras, subconjuntos e intervalos | `STATS`, 301–325 | 25 | 2,500 | 75 |
| Polinomios enteros y coeficientes BigInt | `MATH`, 301–325 | 25 | 2,500 | 75 |
| Matrices enteras y menores por permutación | `MATH`, 326–350 | 25 | 2,500 | 75 |
| Invariantes de grafos por subconjuntos y caminos | `CS`, 301–325 | 25 | 2,500 | 75 |
| Cadenas Unicode por subcadenas y subsecuencias | `CS`, 201–225 | 25 | 2,500 | 75 |
| Teoría de números finita y órbitas de palabras | `MATH`, 223–247 | 25 | 2,500 | 75 |
| Hipergrafos mediante enumeración de vértices y aristas | `CS`, 551–575 | 25 | 2,500 | 75 |
| Órdenes parciales, ideales y extensiones lineales | `MATH`, 501–525 | 25 | 2,500 | 75 |
| Geometría 3D con determinantes exactos | `MATH`, 401–425 | 25 | 2,500 | 75 |
| Matrices y códigos binarios GF(2) | `INFO`, 401–425 | 25 | 2,500 | 75 |
| Lenguajes de autómatas mediante enumeración de palabras | `CS`, 401–425 | 25 | 2,500 | 75 |
| Cálculo numérico frente a soluciones analíticas | `CONTROL`, 401–425 | 25 | 2,500 | 75 |
| **Lote añadido** | **300 IDs distintos** | **300** | **30,000** | **900** |
| **AXIOMA acumulado, incluyendo los 437 previos** | **737/1,000 (73.7%)** | **737** | **73,700** | **2,211** |

En autómatas, las clases de estados equivalentes se obtienen por lenguajes aceptados y se comprueba también la numeración del cociente. En métodos numéricos no se ocultan errores de discretización con un umbral arbitrario: el oráculo usa raíces e integrales analíticas, la corrección exacta del trapecio y del punto medio sobre polinomios cuadráticos y el error analítico del método de Euler en una EDO lineal forzada. Se verifican cotas, convergencia y límites del dominio de prueba.

## Alcance y límites

- Cada operador nuevo cuenta con **100 casos válidos deterministas y tres entradas inválidas**. Los operadores exactos se contrastan por igualdad exacta; las aproximaciones con cotas analíticas o tolerancias declaradas, nunca como precisión infinita.
- Las muestras son conocidas y reproducibles, no constituyen una prueba formal para todas las entradas, ni una evaluación global de precisión arbitraria, velocidad, condicionamiento numérico o hardware cuántico físico.
- PR #391 depende del #390 y, a su vez, del #389. Las tres ramas están separadas de `main`: no presentar este trabajo como fusionado o desplegado.
