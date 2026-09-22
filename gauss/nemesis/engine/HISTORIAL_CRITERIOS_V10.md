# Criterios verificables para terminar NEMESIS

**Actualmente NO satisfechos.** Un ID del inventario no equivale a un producto completo. Los tres módulos añadidos en esta entrega son primitivos de investigación, no los tres motores criptográficos pedidos.

## Motor 81 — Firma postcuántica basada en isogenias

- Definir el esquema de firma concreto y su especificación pública, incluyendo parámetros y seguridad frente a ataques clásicos y cuánticos. No usar SIDH/SIKE como si conservaran su antigua seguridad.
- Implementar generación de claves, firma probabilística o determinista según el esquema, verificación pública y serialización canónica.
- Validar con vectores independientes del esquema, pruebas negativas (mensaje/clave/firma manipulados), límites de memoria/tiempo y auditoría criptográfica. Un cálculo Vélu de grado 2 NO cumple estas condiciones.

## Motor 89 — Criptografía totalmente homomórfica

- Elegir y especificar un esquema completo (p. ej. TFHE/BGV/BFV, con parámetros de seguridad y esquema de ruido medible), llaves públicas/evaluación y formatos interoperables.
- Implementar evaluación sin clave secreta de circuitos arbitrariamente profundos dentro del modelo declarado, incluido bootstrapping real, key switching/relinearización según corresponda y recuperación de presupuesto de ruido.
- Comparar resultados con oráculos de circuitos; ejecutar cadenas de profundidad superior al presupuesto original para demostrar el refresco y verificar las garantías de seguridad y privacidad bajo análisis independiente. El actual DGHV local NO posee bootstrapping.

## Motor 95 — zk-SNARK de ejecución

- Declarar lenguaje de programas, semántica, circuito de restricciones/VM, límites de entrada, supuestos criptográficos y modelo de configuración (ceremonia o transparencia).
- Implementar compilador, witness generator, prover y verifier independientes. El verificador debe usar únicamente statement, proof y parámetros públicos; el proof debe satisfacer las cotas de sucintez del esquema elegido.
- Probar contra verificador independiente y vectores del esquema; falsificación de witness/circuit/public inputs/contexto debe fallar. Realizar revisión de seguridad y rendimiento. La NIZK actual prueba solo relaciones afines módulo q: NO cumple ejecución arbitraria ni sucintez SNARK general.

## Integración y entrega

- Ejecutar las tres implementaciones reales con pruebas cruzadas, CI y evaluación criptográfica externa.
- Integrar con Nexus solo con aprobación del dueño, contratos de entradas, aislamiento de claves, autenticación, control de acceso, versionado y observabilidad.
- Ninguna de las pruebas actuales ni los checksums constituyen certificación de producción.
