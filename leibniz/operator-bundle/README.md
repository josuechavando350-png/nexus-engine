# LEIBNIZ — distribución mínima para agregar lotes

Esta distribución es una reducción **real del conjunto de comandos entregados**, no una autoridad de confianza ni un sandbox. El binario `rust/examples/guarded_append.rs` ejecuta `append_with_policy_witness` y exige el testigo exacto del checkpoint y el testigo exacto de la política de origen. **No incluye** los ejecutables `sequential_source`, `trusted_head_source`, `policy_source`, `policy_witness_source` ni `ingest_authorized_source`: todos permiten otras operaciones y se reservan para laboratorio o administración privilegiada, fuera del entorno de ingesta. Tampoco incluye un CLI para iniciar estados, publicar testigos o exportar archivos; un servicio de administración separado debe provisionarlos y el pipeline de salida se despliega por separado.

## Compilación y prueba en Linux

Desde la raíz del repositorio, con Rust instalado localmente:

```sh
cargo fmt --all --manifest-path leibniz/rust/Cargo.toml -- --check
cargo clippy --all-targets --offline --manifest-path leibniz/rust/Cargo.toml -- -D warnings
cargo build --release --offline --manifest-path leibniz/rust/Cargo.toml --example guarded_append
bash leibniz/operator-bundle/build.sh leibniz/rust/target/release/examples/guarded_append /ruta/nueva/leibniz-operator
(cd /ruta/nueva/leibniz-operator && sha256sum --check SHA256SUMS)
```

El empaquetador exige que el destino no exista; genera exclusivamente `guarded_append` (permisos `0700`), `README.txt` y `SHA256SUMS` (permisos `0600`). Los checksums detectan alteración de bytes comparados con el manifiesto, **pero no autentican a quien entrega ese manifiesto**. El paquete no contiene datos de clientes, credenciales, testigos ni políticas. La tarea [LEIBNIZ guarded operator distribution](../../.github/workflows/leibniz-operator-bundle.yml) ejecuta el **binario del propio paquete** dos veces: antes y después de empaquetarlo y extraerlo, y publica un tar y su SHA-256.

El operador proporciona exactamente once argumentos posicionales:

```text
guarded_append STATE STATE_PIN STATE_HEAD BATCH BATCH_PIN SEQUENCE POLICY POLICY_PIN POLICY_HEAD AS_OF_UTC_MS NEW_STATE
```

El binario rechaza referencias que sean el mismo archivo o enlaces duros, enlaces simbólicos en la última componente en Linux, fuentes revocadas, políticas históricas con testigo vigente diferente, revisiones alternativas con igual número, mediciones fuera de su ventana, secuencias saltadas y sobrescritura del destino. Abre primero las ocho entradas y **lee desde los mismos descriptores**, con comprobación de tipo, tamaño acotado y tamaño/fecha de modificación antes y después de leer. En Linux utiliza `O_NOFOLLOW` para que una sustitución por enlace simbólico de la última componente durante la apertura no redirija la lectura. La ruta de escritura crea una salida nueva con modo `0600`, sincroniza el archivo y después su directorio; si falla la persistencia, intenta retirar la salida.

**Límites precisos:** la comprobación del tamaño/fecha de modificación no bloquea escritores concurrentes ni detecta todas las modificaciones posibles; `O_NOFOLLOW` no impide sustituciones de directorios antecesores o cambios en el contenido de un archivo ya abierto. La sincronización depende de las garantías del sistema de archivos y **no** publica el nuevo testigo del checkpoint en una transacción conjunta. La ejecución debe usar directorios con permisos restrictivos, un solo productor y una autoridad externa que controle la versión vigente. Las pruebas comprueban rechazo de enlaces simbólicos, alias por enlace duro, entrada demasiado grande, política revocada y salida que ya existe; no son una prueba de resistencia a todos los ataques concurrentes ni a un corte eléctrico real.

## Puertas que todavía NO están resueltas

- El origen, los pines y ambos testigos deben venir de **autoridades realmente autenticadas e independientes**. Las pruebas usan copias sintéticas generadas por ellas mismas, nunca prueban consentimiento externo.
- La autoridad de testigos debe mantener una sola versión vigente por fuente y proteger de rollback, forks y escritura concurrente con una actualización atómica de tipo compare-and-swap. Este paquete solo **compara los bytes que recibe**; si se sustituyen también los testigos, se puede eludir.
- `AS_OF_UTC_MS` proviene del operador, no de un reloj confiable. Falta vincularlo a un reloj autenticado y a una política real firmada/verificada; no presentar un digest sin firma como autorización.
- Un administrador que permita ejecutar herramientas heredadas fuera de esta carpeta conserva esas rutas de bypass. Aislar el entorno operativo con permisos, identidades y despliegue controlado, impedir que el productor ejecute otros binarios y auditar los permisos de los datos.
- Falta probar recuperación ante cortes, observaciones reales autorizadas, otras familias matemáticas en GAUSS y funcionamiento de extremo a extremo. Esta entrega **no certifica el 100 % de LEIBNIZ**.
