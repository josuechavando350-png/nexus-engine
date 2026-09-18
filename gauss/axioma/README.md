# AXIOMA — banco independiente de verificación matemática de Nexus

AXIOMA compara resultados de operadores registrados en GAUSS contra referencias **implementadas por separado**. Este PR añade **200 nuevos operadores distintos de los 237 anteriores**, para un objetivo comprobable de **437/1,000 (43.7%)**. Los otros **563 permanecen NO EVALUADOS por AXIOMA**. Esta cobertura no es una garantía de precisión matemática universal.

## Ejecución reproducible

Desde la raíz del repositorio con Node 24:

```sh
node --test gauss/tests/precision-bank-finite-polynomials-v1.test.mjs gauss/tests/axioma-*.test.mjs
node gauss/axioma/run.mjs > /tmp/axioma-report.json
bash walle/adapters/gauss.sh
```

El informe de `runAxioma` registra por suite cada ID, entradas ejecutadas, discrepancias, rechazos de entradas inválidas y SHA-256 determinista de casos con respuestas de referencia. El runner falla ante IDs duplicados o denominadores inconsistentes. El comando `run.mjs` sale con error si se detecta cualquier discrepancia o aceptación inválida. Cada ejecución de CI debe vincularse al **SHA exacto** de su commit; escribir una cifra en este README no constituye evidencia de ejecución.

## Composición del segundo lote

| Referencia nueva | IDs | Operadores nuevos | Casos válidos | Entradas inválidas |
| --- | --- | ---: | ---: | ---: |
| Autómatas celulares elementales | `GAUSS.PHYSICS.CA_*.576–600` | 25 | 2,500 | 75 |
| Conjuntos finitos | `GAUSS.MATH.SET_*.601–625` | 25 | 2,500 | 75 |
| Árboles enraizados | `GAUSS.CS.TREE_*.626–650` | 25 | 2,500 | 75 |
| Intervalos semiabiertos enteros | `GAUSS.CONTROL.INTERVAL_*.651–675` | 25 | 2,500 | 75 |
| Cuadrículas binarias | `GAUSS.CS.GRID_*.701–725` | 25 | 2,500 | 75 |
| Palabras binarias de ancho fijo | `GAUSS.INFO.BIT_*.726–750` | 25 | 2,500 | 75 |
| Endofunciones finitas | `GAUSS.CS.FUNCTION_*.751–775` | 25 | 2,500 | 75 |
| Extracciones de urnas | `GAUSS.STATS.URN_*.776–800` | 25 | 2,500 | 75 |
| **Lote nuevo** | **200 IDs disjuntos** | **200** | **20,000** | **600** |
| **AXIOMA acumulado (incluidos 237 anteriores)** | **437 IDs disjuntos** | **437** | **43,700** | **1,311** |

El banco original contiene 12 referencias a polinomios finitos del rango 676–700, por lo que **no se cuenta todo ese rango otra vez**. Las 200 incorporaciones de este PR se eligen en otros rangos disjuntos; `runAxioma` rechaza IDs repetidos entre suites. Las referencias nuevas incluyen enumeración explícita de estados y espacios finitos, fracciones reducidas BigInt, medidas por ranuras enteras y validación independiente de testigos matemáticos no únicos. Cada operador emplea 100 casos válidos deterministas y tres entradas inválidas. Los tests incluyen mutaciones deliberadas del sujeto que deben producir fallos observables.

## Alcance y límites

- **Cobertura objetivo en este PR:** 437/1,000 operadores. **Conformidad observada:** casos válidos acertados / casos válidos ejecutados. **Rechazo inválido:** casos malformados rechazados / casos malformados ejecutados. No mezclar estos denominadores.
- La mayoría de las comparaciones nuevas son exactas. Las entropías discretas de urnas y las referencias anteriores de códigos binarios usan tolerancia numérica relativa declarada `1e-12 × max(1, |referencia|)`; no son operaciones de precisión arbitraria.
- Semillas y entradas de prueba son deterministas y públicas. No se afirma una demostración formal de exactitud para todos los posibles datos ni se mide rendimiento, condicionamiento global o una QPU física.
- El PR #390 está basado en la rama del PR #389, no en `main`; ninguno debe anunciarse como desplegado o fusionado hasta que eso ocurra. No se alteran aplicaciones de clientes ni configuraciones de despliegue.
