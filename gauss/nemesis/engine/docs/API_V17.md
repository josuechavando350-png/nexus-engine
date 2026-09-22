# Némesis v17 — endurecimiento de límites #89 y #95

Esta entrega **no** equivale a cerrar 100/100 motores ni a una auditoría de seguridad. Preserva el inventario original y los límites documentados en `MATRIZ_100_MOTORES.json`. Las pruebas con binarios de shell dentro de `test/backend-boundary-v17.test.mjs` son **pruebas negativas de rechazo de respuestas falsas**, no ejecuciones de TFHE ni de Groth16.

## #89: datos privados solo por stdin

El ejecutable Rust solo permite `--add-stdin` y `--circuit-stdin <gates> <outputs>`; `255 255` y `--circuit 101 ...` son inválidos. La topología del circuito y los índices de salida siguen siendo públicos en argv. Los bits y sumandos pasan por stdin. El adaptador JS ya usaba stdin y ahora también omite stdout/stderr de procesos fallidos en sus excepciones, para que un ejecutable que imprima secretos no los reproduzca en registros de error. Eso **no impide** que un binario malicioso que recibe stdin extraiga los datos por otros canales: se debe ejecutar solo un binario confiable y fijar `expectedBinarySha256` de manera independiente. `verified:true` en la respuesta únicamente confirma coincidencia con el oráculo booleano local; no aporta una prueba criptográfica del cálculo remoto.

```sh
cd native/fhe
cargo test --release --locked -- --test-threads=1
printf '255 255' | cargo run --release --locked -- --add-stdin
printf '101' | cargo run --release --locked -- --circuit-stdin 'xor:0:1;mux:2:3:1;not:4' '3,4,5'
```

También puede ejecutarse desde la raíz `npm run verify:fhe`, que guarda `evidence/native-fhe-verification.json` con el estado real. Rust, TFHE y sus dependencias no están incluidos como binarios en el ZIP: se necesita Cargo y acceso a la fuente de dependencias para la primera compilación. No se ha ejecutado el motor Rust en este entorno.

## #95: verificación sin falsos positivos por subcadenas

Se sustituyó el reconocimiento inseguro `/OK!/i` y `/ZKey Ok!/i` por una comprobación de la última línea no vacía: debe ser exactamente `OK!` o `ZKey Ok!`, opcionalmente precedida por `[INFO] snarkJS:`. Se rechaza cualquier diagnóstico anterior de error, fallo o prueba inválida. `NOT OK!`, `NOT ZKey Ok!` y `OK! but invalid` ya no pueden pasar como éxito. Un proceso con código de salida distinto de cero no puede pasar. Los errores de subprocesos no incluyen su stdout/stderr porque pueden contener un testigo privado.

Se pueden fijar **opcionalmente** hashes externos de los ejecutables, además del hash de la clave de verificación exigido por la integración:

```js
const tools = {
  circom: '/ruta/absoluta/circom',
  circomSha256: 'sha256_de_64_hex_verificado_previamente',
  snarkjs: '/ruta/absoluta/snarkjs',
  snarkjsSha256: 'sha256_de_64_hex_verificado_previamente'
};
```

Los nombres de hash ilustrativos deben sustituirse por valores reales obtenidos de una fuente independiente. No son hashes de ejemplo utilizables. Si se declara un hash y el ejecutable falta o no coincide, la operación falla **antes** de ejecutarlo. Un hash de un ejecutable por sí solo no acredita su seguridad, sus dependencias transitivas ni la confianza en la ceremonia `.ptau`/`.zkey`.

Para realizar una verificación criptográfica real, use `npm run verify:snark -- <ptau> <zkey> <verification_key.json> <SHA256_CONFIABLE_DE_CLAVE>`. El hash de la clave debe establecerse fuera de la respuesta del probador. Este script continúa sin falsificar herramientas o generar una ceremonia improvisada.

## Pruebas y límites

- `npm test`: suite JavaScript (en Node 22, las cuatro pruebas de ML-KEM se omiten explícitamente porque la API nativa no está disponible).
- `npm run smoke:100`: ejecuta 100 ejemplos, que **no demuestran** el cierre de los 100 motores según el alcance original.
- `node --test test/backend-boundary-v17.test.mjs`: cinco pruebas negativas sobre rechazo de salida engañosa, pins y no filtración de testigos en errores.
- `npm run verify:fhe`: requiere Rust para compilar y ejecutar TFHE de verdad.
- `npm run verify:snark -- ...`: requiere Circom, snarkjs y artefactos confiables de ceremonia.

El motor #81 sigue sin una firma post-cuántica basada en isogenias. Los demás pendientes de alcance original siguen abiertos; estas correcciones no los convierten en certificados.
