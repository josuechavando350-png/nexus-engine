# Némesis dentro de GAUSS — integración en curso, NO CERTIFICADA

La integración conserva los identificadores originales de Némesis bajo `gauss:nemesis` sin modificar el registro de 1000 operadores de GAUSS. Este PR ya contiene la fuente Rust TFHE del motor #89, el puente GAUSS para suma cifrada y circuitos booleanos y sus pruebas de rechazo. **Todavía NO contiene `gauss/nemesis/engine/` con la fuente JavaScript completa de los 100 motores**. No fusionar ni declarar 100/100 hasta transferirla y superar los gates.

## Entrada nativa operativa de #89

El código del PR expone `runGaussNemesis('89', {action:'native-add-u8',a:255,b:255,expectedBinarySha256:'<SHA-256 CONFIABLE>'})` y `native-circuit` con `inputs`, `gates` y `outputs`. Rust recibe los bits privados exclusivamente por stdin. El hash del ejecutable se exige como pin de confianza aportado por quien lo llama; **calcularlo sobre el mismo binario en CI es una prueba de consistencia, no un certificado externo de procedencia**. El puente comprueba independientemente el resultado y se niega a continuar sin binario/pin o con datos y respuestas inválidos. Para otros IDs, la API falla explícitamente si falta la fuente original.

El workflow `.github/workflows/gauss-nemesis-rust.yml` instala Rust/Cargo y ejecuta `cargo test --release` de TFHE, pruebas JS del adaptador, suma y circuito a través de la API pública de GAUSS. Guarda binario, Cargo.lock y evidencia de esa revisión como artefacto de CI. La primera ejecución exitosa de `rust-native` fue GitHub Actions #35746029691; el gate **gauss-integration falló correctamente por la fuente JavaScript aún ausente**. Los tests del #89 cubren funcionalidades booleanas acotadas; no certifican su seguridad criptográfica en producción ni el alcance completo del #89.

## Pruebas y requisitos pendientes

```bash
node --test gauss/nemesis/tests/native-fhe.test.mjs
cargo test --release --manifest-path gauss/nemesis/native/fhe/Cargo.toml
node gauss/nemesis/scripts/verify-native-89.mjs
# Los siguientes requieren transferir el código íntegro Némesis v17:
node --test gauss/nemesis/tests/bridge.test.mjs
node gauss/nemesis/engine/scripts/smoke-100.mjs
node --test gauss/nemesis/engine/test/*.test.mjs
```

La transferencia debe preservar el inventario, las pruebas, todos los archivos de `src/` y los ejemplos de Némesis, sin reemplazar funcionalidades por variantes reducidas. Aún falta evaluar el alcance original de todos los motores; en particular #81 no implementa todavía una firma por isogenias completa y #95 requiere una ceremonia Groth16 de confianza y prueba real. No se deben confundir 100 entradas registradas o 100 ejemplos con 100 motores certificados.
