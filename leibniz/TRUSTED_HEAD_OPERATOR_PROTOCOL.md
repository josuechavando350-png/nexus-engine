# LEIBNIZ — protocolo del testigo de versión más reciente

**Estado:** puerta de validación local, no despliegue de confianza externa. Código: `rust/src/trusted_head.rs`, CLI: `rust/examples/trusted_head_source.rs`; pruebas de integración sintéticas: `fase18-payload/trusted_head.test.mjs`. No almacenar datos de clientes en el repositorio público.

## Problema corregido dentro de un límite de confianza

Un checkpoint `S1` puede ser válido y su copia ordinaria puede contener exactamente los mismos bytes que `S1`. Si ya se aceptó `S2`, sustituir **ambos** archivos por `S1` no produce diferencia en una mera comprobación de igualdad de copias. El modo protegido exige también `LEIBNIZ_TRUSTED_HEAD_V1\t<fuente>\t<última_secuencia>\n`, tomado de **otro dominio de confianza**. Si el testigo conservado dice `2`, un checkpoint y pin antiguos de secuencia `1` no pueden pasar `append` ni `extract` protegidos. Se exige igualdad exacta de la fuente, la secuencia y los bytes del checkpoint con su pin, además de la continuidad del lote.

**No se implementa** una autoridad independiente, un almacén inmutable, firmas, gestión de claves, consulta de red, atestación del hardware, bloqueo frente a escritores simultáneos o protección frente a un atacante que también controla el testigo. El archivo `propose` **no es** por sí mismo prueba de legitimidad. No publicar en producción los tres archivos en una única carpeta mutable o bajo las mismas credenciales. El CLI previo `sequential_source` sigue disponible por compatibilidad: su `append` y `extract` **no** comprueban testigos; solo `trusted_head_source` aplica esta puerta.

## Uso por el operador

1. Crear checkpoint inicial con `sequential_source init SOURCE_ID INIT.state`. Retener sus bytes por un canal de referencia separado; generar `trusted_head_source propose INIT.state INIT.pin HEAD.proposed`.
2. Autenticar el origen del checkpoint y publicar `HEAD.proposed` como **único testigo más reciente** en una autoridad externa, monotónica y controlada por un operador distinto, con política contra reemplazo y retroceso. Consultar el valor vigente antes de cada operación: nunca derivarlo del mismo checkpoint que se pretende verificar.
3. Ejecutar `trusted_head_source append PREVIOUS.state PREVIOUS.pin TRUSTED_HEAD BATCH.tsv BATCH.pin NEXT_SEQUENCE NEW.state`. El comando solo crea un nuevo checkpoint si coinciden la fuente y la secuencia vigentes, los bytes de referencia y la siguiente secuencia; no modifica los originales.
4. Obtener por separado una referencia auténtica de `NEW.state`. Ejecutar `trusted_head_source propose NEW.state NEW.pin NEW_HEAD.proposed`; comprobar y publicar este nuevo testigo de forma atómica y monotónica **antes de aceptar otra operación**. El motor aún no automatiza ni certifica la atomicidad de este paso.
5. Para exportar, consultar de nuevo el testigo vigente y ejecutar `trusted_head_source extract CURRENT.state CURRENT.pin TRUSTED_HEAD OUT.archive`; el consumidor posterior requiere una referencia independiente del archivo exportado.

## Regla de certificación

Las pruebas unitarias reproducen un ataque donde se revierten juntos checkpoint y pin, pero **no** el testigo, y la operación falla. Incluyen asimismo una prueba que demuestra el límite: si también retrocede el testigo, el motor no puede saber que existió un estado más reciente. El flujo de CI usa datos y testigos **sintéticos generados localmente**; no acreditan un servicio monotónico externo real. Hasta desplegar y someter a prueba esa autoridad, la fila M-03 del manifiesto sigue `PARCIAL`, no `VERIFICADO`.
