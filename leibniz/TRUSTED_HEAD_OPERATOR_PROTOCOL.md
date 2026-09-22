# LEIBNIZ — protocolo del testigo de versión más reciente

**Estado:** puerta de validación local, no despliegue de confianza externa. Código: `rust/src/trusted_head.rs`, CLI: `rust/examples/trusted_head_source.rs`; pruebas sintéticas: `fase18-payload/trusted_head.test.mjs` y pruebas Rust. No almacenar datos de clientes en el repositorio público.

## Problema corregido dentro de un límite de confianza

Un checkpoint `S1` puede ser válido y su copia ordinaria puede contener exactamente los mismos bytes que `S1`. Si ya se aceptó `S2`, sustituir **ambos** archivos por `S1` no produce diferencia en la mera comprobación de igualdad de copias. Un testigo que solo almacene el número de secuencia **tampoco** detecta una versión alternativa y alterada de `S2`. Por eso el modo protegido requiere una copia íntegra del checkpoint vigente en un dominio de confianza diferente: un registro binario `LEIBNIZ_TRUSTED_HEAD_V2\t<fuente>\t<secuencia>\t<longitud>\n<bytes exactos del checkpoint>`.

Al ejecutar `append` o `extract` protegido, LEIBNIZ exige simultáneamente que coincidan los bytes del checkpoint, su copia ordinaria y los bytes contenidos en el testigo externo; también verifica identidad de fuente, secuencia canónica, integridad semántica y continuidad de entrega. **Se conservan bytes completos, no solo un checksum débil ni una cifra de versión.** Esto requiere espacio adicional comparable al tamaño del checkpoint, acotado a 83 MiB por testigo. No significa que LEIBNIZ autentique quién publicó el testigo.

**No se implementa** una autoridad independiente, un almacén inmutable, firmas, gestión de claves, consulta de red, atestación del hardware, exclusión mutua de escritores simultáneos ni protección frente a un atacante que también controla el testigo. El archivo `propose` **no es** por sí mismo prueba de legitimidad. No publicar en producción los tres archivos en una única carpeta mutable o bajo las mismas credenciales. El CLI previo `sequential_source` sigue disponible por compatibilidad: su `append` y `extract` **no** comprueban testigos; solo `trusted_head_source` aplica esta puerta.

## Uso por el operador

1. Crear checkpoint inicial con `sequential_source init SOURCE_ID INIT.state`. Retener sus bytes por un canal de referencia separado; generar `trusted_head_source propose INIT.state INIT.pin HEAD.proposed`.
2. Autenticar el origen del checkpoint y publicar `HEAD.proposed` como **único testigo más reciente** en una autoridad externa, monotónica y controlada por un operador distinto, con política contra reemplazo, bifurcación y retroceso. Consultar el valor vigente antes de cada operación: nunca derivarlo del mismo checkpoint que se pretende verificar.
3. Ejecutar `trusted_head_source append PREVIOUS.state PREVIOUS.pin TRUSTED_HEAD BATCH.tsv BATCH.pin NEXT_SEQUENCE NEW.state`. El comando solo crea un nuevo checkpoint si coinciden la fuente, secuencia y **bytes exactos** del testigo vigente con el estado anterior, además del pin y la siguiente secuencia; no modifica los originales.
4. Obtener por separado una referencia auténtica de `NEW.state`. Ejecutar `trusted_head_source propose NEW.state NEW.pin NEW_HEAD.proposed`; comprobar y publicar el nuevo testigo de forma atómica y monotónica **antes de aceptar otra operación**. El motor aún no automatiza ni certifica la atomicidad de este paso.
5. Para exportar, consultar de nuevo el testigo vigente y ejecutar `trusted_head_source extract CURRENT.state CURRENT.pin TRUSTED_HEAD OUT.archive`; el consumidor posterior requiere una referencia independiente del archivo exportado.

## Regla de certificación

Las pruebas reproducen sustitución simultánea del checkpoint y su pin por un estado viejo, **y** sustitución por un historial alternativo válido con el mismo número de secuencia. Ambas fallan si el testigo vigente conserva los bytes auténticos. Hay asimismo una prueba del límite: si también retrocede el testigo, LEIBNIZ no puede saber que existió un estado más reciente. El flujo de CI usa datos y testigos **sintéticos generados localmente**; no acredita una autoridad monotónica externa real. Hasta desplegar y someter a prueba esa autoridad, la fila M-03 del manifiesto sigue `PARCIAL`, no `VERIFICADO`.
