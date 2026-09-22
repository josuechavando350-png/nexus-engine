# LEIBNIZ — testigo exacto de la política vigente

**Alcance:** modo protegido `rust/src/policy_witness.rs` + CLI `rust/examples/policy_witness_source.rs`. No autentica al emisor ni publica un testigo en una autoridad real; los tests de CI emplean políticas y copias sintéticas. El repositorio es público: no subir políticas privadas, datos de clientes ni claves.

## Por qué no basta la revisión

La política de origen `LEIBNIZ_SOURCE_POLICY_V1` comprueba fuente, revisión mínima indicada por el operador, permiso/revocación, secuencia, ventana temporal y validez de las observaciones. Una revisión mínima introducida por el mismo actor que controla el archivo puede retrocederse junto con éste; además dos políticas incompatibles pueden declarar la misma revisión. La puerta nueva exige un **testigo de política vigente** que guarda literalmente los bytes completos de esa política, además de su identidad y revisión.

`LEIBNIZ_POLICY_HEAD_V1\tFUENTE\tREVISION\tLONGITUD\n` seguido de los bytes canónicos exactos de `LEIBNIZ_SOURCE_POLICY_V1`. El registro está acotado a 1024 bytes. No se llama firma, MAC, hash criptográfico ni certificado de autorización. Como en `TRUSTED_HEAD_OPERATOR_PROTOCOL.md`, la propuesta se vuelve confiable **solo** cuando una autoridad independiente autentica su origen y la publica como versión única vigente con protección monotónica y actualización atómica.

## Uso operativo

1. Obtener por canales distintos una política legítima y su referencia exacta. Ejecutar `cargo run --release --offline --manifest-path leibniz/rust/Cargo.toml --example policy_witness_source -- propose POLICY POLICY_PIN CANDIDATE.policy-head`.
2. Autoridad externa: validar emisor, permisos, vigencia y monotonicidad; publicar la propuesta bajo una clave por fuente. Si se revoca una fuente, publicar **el nuevo testigo de revocación** antes de aceptar lotes siguientes. No guardar el testigo junto con política/checkpoint bajo las mismas credenciales.
3. Obtener de nuevo ese testigo vigente, la referencia independiente del checkpoint y su testigo; ejecutar `policy_witness_source append STATE STATE_PIN STATE_HEAD BATCH BATCH_PIN NEXT_SEQUENCE POLICY POLICY_PIN POLICY_HEAD AS_OF_UTC_MS NEXT_STATE` con los ejecutables compilados. Se exige coincidencia exacta con **ambos testigos**, autorización activa, vigencia y continuidad; no se sobrescriben originales. El consumidor deberá publicar el nuevo testigo del checkpoint antes de otro lote.
4. No permitir el comando heredado `policy_source append` como sustituto del modo protegido: éste usa revisión mínima proporcionada por el operador, pero **no** compara el testigo exacto de política. Lo mismo aplica a `sequential_source` sin testigo.

## Pruebas y pendientes

Los tests unitarios comprueban permiso vigente; revocación con revisión mayor; cambio de permiso en la **misma** revisión; alteración o codificación no canónica del testigo; y pin inconsistente. Los tests Node ejecutan los binarios reales con dos lotes hasta GAUSS/Quantum, y rechazan versiones antiguas y alternas sin crear un checkpoint aceptado. Esta prueba de laboratorio NO acredita fuente externa real, custodia independiente, exclusión de productores concurrentes, rotación de claves, reloj confiable ni recuperación transaccional. Si quien ataca sustituye también el testigo, puede derrotar esta puerta. La matriz M-03 permanece PARCIAL hasta demostrar esas propiedades en un despliegue autorizado.
