# Némesis v14: integración incremental real de #95 y #89

## #95 — Groth16, circuito acotado de aritmética de campo

Nuevo compilador de programas DAG a restricciones R1CS **y** Circom 2. Admite entradas
privadas, constantes BN254, suma, resta, multiplicación y selector booleano
(con restricción `s * (s-1) = 0`), y una salida pública. El compilador limita
cada programa a 64 entradas privadas y 128 nodos; no compila programas JS/Rust
arbitrarios, bucles, comparaciones, divisiones, hashes ni pruebas de rango.
Las operaciones son **modulares**, no aritmética entera sin desbordamiento.

El backend real ejecuta `circom` y `snarkjs` instalados por el usuario:
`circom --r1cs --wasm`, `snarkjs zkey verify`, exportación de clave, `snarkjs
groth16 fullprove` y `snarkjs groth16 verify`. Genera y limpia temporalmente
los archivos de testigo, sin devolver ni imprimir el testigo privado.
**No hay reemplazo silencioso por Schnorr.** El modo Schnorr antiguo permanece
solo bajo `mode:'prove' | 'verify'` y se identifica por su dominio original.

`runMotor('95',{action:'compile',program})` devuelve fuente y R1CS explícitas;
`action:'check'` recibe `witness` como lista de enteros decimales canónicos y
verifica todas las restricciones. `action:'prove'` recibe además rutas a `.ptau`
y `.zkey`, `trustedVerificationKeySha256` y opcionalmente `tools`. Se requiere
una ceremonia Groth16 confiable propia de **ese** circuito, con contribuciones
verificadas: este paquete **no genera ni certifica** el setup. El verificador
`action:'verify'` exige programa, declaración y prueba, `verificationKey` y
**dos pins confiables previamente establecidos fuera de la declaración del
probador**: `expectedProgramSha256` y `expectedVerificationKeySha256`.
Nunca aceptar los hashes calculados por quien presenta la prueba como autoridad.

Preparar el circuito público (no incluye secretos):

```sh
node scripts/prepare-snark-95.mjs examples/v14/motor-95-program.json ./snark95-build
circom snark95-build/nemesis95.circom --r1cs --wasm -o snark95-build
```

Después de organizar y verificar una ceremonia de Powers of Tau y fase 2 de
Groth16 para `snark95-build/nemesis95.r1cs`, proporcionar `pot_final.ptau`,
`circuit_final.zkey` y `verification_key.json`, y ejecutar:

```sh
node scripts/verify-snark-95.mjs /ruta/pot_final.ptau /ruta/circuit_final.zkey /ruta/verification_key.json
```

Este test ejecuta una prueba válida y rechazos de salida, programa, clave y
prueba alteradas. Sale con código no nulo si falta el ejecutable, las claves,
la ceremonia correcta o falla cualquier prueba. Escribe evidencia sin el testigo
en `evidence/native-snark-95-verification.json`. La verificación local del
compilador R1CS con Node **no** demuestra que Groth16 funcione sin estos pasos.
No se garantiza seguridad de producción sin examinar la procedencia de las
herramientas, la ceremonia y la custodia de claves.

## #89 — adaptador público para binario nativo

`runMotor('89',{action:'native-add-u8',a:255,b:255})` invoca el ejecutable real
`native/fhe/target/release/nemesis-fhe` (o `.exe` en Windows). `binary` permite
indicar una ruta explícita. Verifica el JSON del ejecutable y contrasta que la
suma cifrada descifrada sea `a + b`; retorna su SHA-256. Si falta el ejecutable,
la llamada falla: nunca usa el esquema educativo como sustitución. El código
Rust ya estaba en v13, pero **no se ha podido compilar en este entorno**.
Para verificarlo con Rust disponible: `node scripts/verify-native-fhe.mjs`.

## Estado

Esta entrega conecta más capacidades y suma pruebas JS. #89 aún necesita
pruebas Rust reales y #95 pruebas con binarios, `.ptau` y `.zkey` verificados.
#81 aún no implementa una firma segura basada en isogenias. Otros motores
mantienen los pendientes originales descritos en `docs/MATRIZ_100_MOTORES.json`.
Por tanto, ni #81, ni #89, ni #95, ni los 100 motores se declaran certificados.

Referencias de formatos y ceremonia:
- https://docs.circom.io/getting-started/proving-circuits/
- https://github.com/iden3/snarkjs/blob/master/README.md
