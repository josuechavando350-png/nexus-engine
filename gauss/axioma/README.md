# AXIOMA — banco independiente de verificación matemática de Nexus

AXIOMA compara resultados de GAUSS con cálculos de referencia **implementados por separado**. El banco reúne **237 operadores únicos de 1,000 (23.7% de cobertura): los 37 originales y un lote completo de 200 adicionales**. Los 763 restantes permanecen **NO EVALUADOS por AXIOMA**. La cobertura no es un porcentaje de precisión general; los resultados observados corresponden exclusivamente a los casos y límites declarados.

## Ejecución y evidencia

Desde la raíz del repositorio, con Node 24:

```sh
node --test gauss/tests/precision-bank-finite-polynomials-v1.test.mjs gauss/tests/axioma-*.test.mjs
node gauss/axioma/run.mjs > /tmp/axioma-report.json
```

El ejecutor produce JSON reproducible por suite y operador, con entradas válidas, resultados, discrepancias, rechazo de entradas inválidas y SHA-256 de entradas más respuestas de referencia. Sale con código distinto de cero ante discrepancias o aceptación indebida de entradas inválidas. `bash walle/adapters/gauss.sh` ejecuta también las pruebas en el flujo conectado de GAUSS, WALLE y la simulación interna de Quantum. Cada resultado de CI debe atribuirse a su **SHA exacto**; las cifras de abajo son denominadores fijos comprobados por pruebas, no un sustituto del reporte ejecutado.

## Alcance del lote completo

| Suite | Operadores únicos | Casos válidos | Entradas inválidas | Referencia separada |
| --- | ---: | ---: | ---: | --- |
| Polinomios sobre cuerpos primos | 12 | 1,200 | 36 | BigInt modular, expansión de monomios y potencias |
| Permutaciones finitas | 25 | 2,500 | 75 | Enumeración exhaustiva de S_n para 1 ≤ n ≤ 6 |
| Teoría de números | 11 | 1,100 | 33 | Divisores, residuos, potencias, fracciones y testigos |
| Grafos finitos | 12 | 1,200 | 36 | Subconjuntos, caminos, ciclos y coloraciones |
| Funciones booleanas | 25 | 2,500 | 75 | Tablas de verdad, sumas sobre subconjuntos y distancia afín |
| Relaciones binarias finitas | 25 | 2,500 | 75 | Conjuntos de pares y enumeración de caminos |
| Particiones y composiciones | 25 | 2,500 | 75 | Enumeración de cortes y celdas de Ferrers |
| Árboles ponderados | 25 | 2,500 | 75 | Caminos únicos, sumas de pares y búsqueda por eliminación de aristas |
| Códigos binarios | 25 | 2,500 | 75 | Prefijos explícitos, fracciones BigInt y decodificación independiente |
| Matrices sobre cuerpos primos | 25 | 2,500 | 75 | Determinantes por permutaciones, menores y eliminación separada |
| Series y polinomios racionales | 25 | 2,500 | 75 | Fracciones BigInt reducidas, convolución y recurrencias formales |
| Cadenas de Markov exactas | 2 | 200 | 6 | Productos enteros de pesos y denominadores de transición |
| **Total (sin IDs repetidos)** | **237/1,000 (23.7%)** | **23,700** | **711** | **200 operadores nuevos; 763 no evaluados** |

El runner exige 1,000 operadores en el registro, IDs únicos, igualdad entre cobertura y resultados por operador, denominadores independientes para casos válidos y entradas inválidas, y resultados sin discrepancias. Cada operador tiene 100 casos válidos deterministas y tres entradas inválidas. Las pruebas de mutación inyectan resultados erróneos y aceptación de datos malformados para comprobar que los detectores fallan de manera cerrada. Cuando un problema admite múltiples testigos correctos, la suite verifica validez y optimalidad, no identidad de representación.

## Interpretación responsable

- **Cobertura**: 237/1,000 operadores. **Conformidad observada**: resultados correctos/casos válidos ejecutados. **Rechazo inválido**: entradas inválidas rechazadas/entradas inválidas ejecutadas. No combinar denominadores.
- La mayoría de los operadores evaluados usan igualdad exacta. Los dos resultados de entropía y redundancia en códigos binarios, que usan coma flotante, se comparan con una tolerancia relativa predeclarada de `1e-12` multiplicada por `max(1, |valor de referencia|)`; no son pruebas de precisión arbitraria ni de exactitud binaria.
- Semillas y muestras son deterministas y públicas; no hay un conjunto externo ciego. Referencias separadas no constituyen prueba formal universal de todas las entradas.
- AXIOMA **no mide** rendimiento, estabilidad o condicionamiento numérico global, precisión arbitraria ni ejecución en una QPU física. No atribuir éxito ni fracaso a los 763 operadores que siguen fuera de este banco.
- Esta rama parte del banco `507d09fe3be45e6dde572e9306e2aab280930eed`, está separada de `main` y no cambia aplicaciones de clientes ni despliegues. Solo una ejecución verde contra el SHA final permite describir esta versión como validada.
