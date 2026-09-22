# LEIBNIZ — aceptación acotada de consentimiento y revocación de fuentes

Implementación ejecutable: `../rust/src/source_policy.rs` y `../rust/examples/policy_source.rs`. Pruebas Rust: seis pruebas nuevas en `source_policy.rs`. Pruebas de extremo a extremo: `policy_source.test.mjs` (cuatro casos con el ejecutable Rust; caso aceptado llega a GAUSS y recibe el comprobante correspondiente de Quantum). Evidencia: [CI 35696615582](https://github.com/josuechavando350-png/nexus-engine/actions/runs/35696615582), commit `69ba17a7c44ac173d3263b6ef6a41a0042054bb9`: 252 Rust debug + 252 release, formato, Clippy, ejecución integrada y paquete limpio.

## Contrato observado

El nuevo formato canónico `LEIBNIZ_SOURCE_POLICY_V1` registra identidad de fuente, revisión positiva, estado `ALLOW` o `REVOKED`, rango cerrado de secuencias permitidas y ventana de UTC en milisegundos con fin exclusivo. Para aceptar una entrega exige además un mínimo de revisión indicado por el operador, coincidencia exacta de política con su referencia por separado, testigo del checkpoint previamente protegido, lote de fuente con referencia de bytes separada y validez temporal de cada flujo/restricción. Una negativa no crea un checkpoint válido de salida. `policy_source append` produce un checkpoint nuevo; no altera los anteriores ni publica por sí mismo un testigo actualizado.

No sustituye al ingestor anterior: `sequential_source append` y `trusted_head_source append` siguen existiendo y **no** aplican esta política. El consumidor que necesite consentimiento revocable debe llamar a `policy_source append` y restringir acceso a rutas antiguas; no se demuestra aquí control de acceso a todos los ejecutables.

## Límites que impiden certificar una fuente externa

Los datos, pines, políticas y testigos de las pruebas son generados localmente y **sintéticos**. El CLI no autentica al emisor de políticas, ni dispone de reloj seguro, ni obtiene por sí mismo una revisión mínima monotónica. Un operador o atacante que pueda reemplazar conjuntamente política, pin y mínimo de revisión puede reautorizar una fuente retirada. Tampoco existe consulta de una fuente real, exclusión mutua de escritores, publicación atómica de política y checkpoint, recuperación certificada tras corte eléctrico ni atestación criptográfica. Nunca colocar información privada real en el repositorio público.

**Por tanto:** revocación y vigencia quedan probadas como controles de código bajo entradas confiables; autenticidad, privacidad operativa e ingesta continua del manifiesto siguen **PARCIALES o SIN EVIDENCIA** según cada requisito. No se expresa porcentaje global ni se declara cerrado el manifiesto original.
