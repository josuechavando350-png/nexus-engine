# Némesis dentro de GAUSS — integración en curso, NO CERTIFICADA

La integración conserva los identificadores originales de Némesis bajo `gauss:nemesis` sin modificar el registro de 1000 operadores de GAUSS. Este PR ya contiene la fuente Rust TFHE del motor #89, el puente GAUSS para suma cifrada y circuitos booleanos y sus pruebas de rechazo. **Todavía NO contiene `gauss/nemesis/engine/` con la fuente JavaScript completa de los 100 motores**. No fusionar ni declarar 100/100 hasta transferirla y superar los gates.

## Entrada nativa operativa de #89

La API `runGaussNemesis('89', {action:'native-add-u8',a:255,b:255,expectedBinarySha256:'<SHA-256 CONFIABLE>'})` y la acción `native-circuit` invocan el ejecutable Rust real. Los bits privados llegan por stdin; se requiere un hash confiable del ejecutable y las salidas se comprueban mediante un oráculo booleano local. Calcular SHA-256 del mismo binario durante CI es una prueba de consistencia, no una certificación externa de procedencia. El puente nunca reemplaza los restantes motores por stubs.

Rust y Cargo 1.98.1 fueron instalados y probados en GitHub Actions; el job `rust-native` #35746029691 compiló `tfhe = 1.8.1`, pasó las cinco pruebas nativas y devolvió `255+255=510` y `[true,true,false]` con circuitos cifrados. La nueva revisión añade una prueba del #89 **a través de la API pública de GAUSS** y conserva como artefactos el binario, Cargo.lock y la evidencia; sus resultados deben verificarse en el run nuevo, no extrapolar el job anterior.

## Candado de identidad de fuente para los 100

`source-lock.json` fija hashes calculados sobre el archivo Némesis v17 local: 100 archivos JavaScript bajo `engine/src/`, 31 pruebas, 130 ejemplos, el inventario de 100 ID y `package.json`. `node gauss/nemesis/scripts/verify-source-lock.mjs` bloquea ausencias o cualquier cambio de bytes. Esta comprobación **no verifica el alcance conceptual**: asegura que llega exactamente la versión auditada en local. El gate `gauss-integration` deliberadamente falla hasta que se importe `engine/` y pasen las pruebas completas sobre el mismo SHA.

## Validación antes de fusionar

```bash
node --test gauss/nemesis/tests/native-fhe.test.mjs
cargo test --release --manifest-path gauss/nemesis/native/fhe/Cargo.toml
node gauss/nemesis/scripts/verify-native-89.mjs
# Lo siguiente requiere la fuente completa bajo gauss/nemesis/engine/:
node gauss/nemesis/scripts/verify-source-lock.mjs
node --test gauss/nemesis/tests/*.test.mjs
node --test --test-concurrency=4 gauss/nemesis/engine/test/*.test.mjs
node gauss/nemesis/engine/scripts/smoke-100.mjs
```

La transferencia debe preservar inventario, fuentes, todas las pruebas y ejemplos. Aún faltan cubrir el alcance original del #81 (firma por isogenias), seguridad/alcance de producción #89 y ceremonia confiable y verificación real Groth16 #95. El motor #89 depende de la biblioteca Rust `tfhe`, por lo que no es independiente de terceros. No confundir un inventario de 100 IDs ni 100 ejemplos con 100 motores certificados.
