# Némesis v15: ampliación comprobable de #89 y refuerzo de #95

Esta versión no cierra el alcance original de los 100 motores. Preserva los 100 IDs.

## #89: circuito booleano arbitrario acotado por TFHE nativo

`runMotor('89', {action:'native-circuit', inputs:[true,false,true], gates:[
  {op:'xor',a:0,b:1}, {op:'mux',s:2,a:3,b:1}, {op:'not',a:4}
], outputs:[3,4,5]})` ejecuta el evaluador TFHE Rust real **si está
compilado y disponible**. Sin ejecutable, falla explícitamente. La entrada se
valida antes de ejecutar ningún proceso: 1–128 bits, 0–2048 compuertas, 1–128
salidas, referencias anteriores únicamente y operaciones NOT, AND, OR, XOR,
NAND, NOR, XNOR y MUX. Las referencias de entrada ocupan 0..N-1; la puerta i
produce N+i. La salida se compara bit por bit contra un evaluador booleano
independiente en JavaScript; este chequeo detecta incoherencias locales pero
**no es una prueba criptográfica** de evaluación de un servidor malicioso.

El adaptador transmite las entradas privadas mediante **stdin**, no mediante
argumentos del proceso; el DAG y los índices de salida son públicos. Rust
utiliza `tfhe::boolean::gen_keys()`, cifra las entradas, evalúa cada puerta
con `ServerKey` y solo descifra al terminar. No se almacenan claves ni
ciphertexts. Se preserva `native-add-u8` con entrada privada por stdin y
suma a 9 bits. La API Rust conserva también los argumentos antiguos para
compatibilidad; para datos privados utilice el adaptador JavaScript o los
modos `--circuit-stdin` / `--add-stdin`. No hay protocolo remoto, aislamiento
de proceso para el cliente y el evaluador, ni gestión persistente de claves.

Para fijar un ejecutable examinado previamente, pase `binary` y
`expectedBinarySha256` (hash minúsculo de 64 caracteres procedente de una
fuente confiable ajena a la respuesta del programa). El hash se comprueba
**antes** de arrancarlo. Sin pin, `binaryPinned:false` indica que su
procedencia **no** se acreditó. Incluso con hash, solo se identifica un binario,
no se certifica automáticamente su código, TFHE ni su entorno de ejecución.
`verified:true` significa únicamente igualdad de las salidas descifradas con
el oráculo local. La dependencia `tfhe = 1.8.1` es de terceros: **no** se
reivindica independencia de bibliotecas criptográficas externas.

Comprobación real en una máquina con Rust y acceso a crates.io:

```sh
node scripts/verify-native-fhe.mjs
```

El script ejecuta la suite Rust, la suma cifrada 255+255, un circuito cifrado
XOR/MUX/NOT y compara ambas respuestas con resultados independientes. Registra
resultados, versiones y hashes en `evidence/native-fhe-verification.json`.
No se pudo compilar Rust en este entorno: NO_CERTIFICADO.

## #95: verificación del origen de la clave

La prueba de integración Groth16 **ahora exige** un SHA-256 confiable de
la clave de verificación obtenido fuera del propio script. La v14 generaba
su supuesto pin desde el mismo archivo de clave recibido: esa igualdad no
acreditaba confianza en la clave. El comando corregido es:

```sh
node scripts/verify-snark-95.mjs /ruta/pot_final.ptau /ruta/circuit_final.zkey /ruta/verification_key.json <SHA256_CONFIABLE_DE_CLAVE>
```

El hash es el SHA-256 de `canonicalSnarkJson(JSON.parse(verification_key.json))`,
no el hash de los bytes sin procesar. Se debe anotar y aprobar **antes** de
recibir una prueba del probador, por un canal confiable junto con el hash del
programa. Pasar el hash que acaba de calcular el propio probador no da
seguridad. El script falla antes de invocar las herramientas si difiere del
pin externo. Se añadieron 120 pruebas de propiedades con 20 nodos cada una,
comparando resultados contra un evaluador de campo independiente, más pruebas
de que el script exige un pin externo. La ejecución nativa de circom/snarkjs
y la ceremonia de claves permanecen pendientes; la prueba R1CS no sustituye
una prueba Groth16 real.

## Evidencia y límites globales

Con Node.js 22.16.0 se ejecutaron dos lotes de tests JS, sin excluir pruebas
de estos motores. El fichero `test/crypto-nash-qaoa.test.mjs` no arranca aquí:
requiere primitivas ML-KEM presentes en Node 24.19+; no se sustituyen por
criptografía insegura. Los tests de Rust y Groth16 requieren los binarios y
los artefactos criptográficos correspondientes. Consultar
`evidence/RELEASE_V15.json` y los logs de cada lote. #81 continúa sin una
firma basada en isogenias. Los restantes límites de los 100 IDs se conservan
en `docs/MATRIZ_100_MOTORES.json`.
