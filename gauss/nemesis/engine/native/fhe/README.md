# Actualización v15

Además de la suma de bytes, el binario acepta `--circuit-stdin <puertas> <salidas>` y lee los bits privados desde stdin (sin nueva línea). Puertas: `xor:0:1;mux:2:3:1;not:4`; salidas: `3,4,5`; bits privados de ejemplo: `101`. `--add-stdin` lee dos bytes decimales separados por espacio desde stdin. El adaptador `runMotor('89', {action:'native-circuit',...})` usa esos modos y admite pin de SHA-256 del binario. `node scripts/verify-native-fhe.mjs` ahora valida los dos modos, además de la suite Rust. **Este entorno carece de Rust; las pruebas nativas no se han ejecutado aquí**. Para límites actualizados y privacidad, consultar `docs/API_V15.md`. La documentación v12 que sigue es histórica.

---

# Némesis — motor 89, backend Rust TFHE

Código fuente nuevo; **no compilado ni ejecutado en el entorno de esta entrega**,
porque aquí no están disponibles `rustc` y `cargo`. Las 357 pruebas de v11 y las
pruebas JavaScript añadidas no validan este backend nativo.

## Implementación

- Evaluador de DAG booleano con NOT, AND, OR, XOR, NAND, NOR, XNOR y MUX.
- Cálculo cifrado mediante TFHE-rs 1.8.1, característica `boolean`.
- El método `Circuit::evaluate` recibe `ServerKey` y ciphertexts; no recibe
  `ClientKey` ni descifra intermediarios.
- Validación completa de referencias antes del cálculo; rechazo de ciclos,
  referencias futuras, salidas inexistentes y exceso de límites.
- Compilador de suma binaria sin signo, acarreo de entrada y salida incluidos.
- Binario demostrador de suma cifrada de dos bytes, contrastada con suma entera.
- Pruebas: tablas de verdad exhaustivas de todas las compuertas, cadena de 1024
  NAND dependientes y sumas con acarreo y desbordamiento a 9 bits. No hay pruebas
  nativas ignoradas deliberadamente.

El refresco criptográfico lo aporta TFHE; no es la primitiva educativa de v10.
NOT por sí sola no requiere bootstrapping. La prueba de profundidad usa NAND.
La dependencia se fija exactamente; las dependencias transitivas se resuelven
al generar `Cargo.lock`, que debe conservarse con el resultado de verificación.

## Ejecutar con tu Rust

Desde la raíz de Némesis, con Node disponible:

```sh
node scripts/verify-native-fhe.mjs
```

El script genera el lockfile si falta, ejecuta toda la suite nativa en release
y la suma 255+255, y guarda versiones, hashes, salidas y resultado en
`evidence/native-fhe-verification.json`. Termina con código distinto de cero
si falta una herramienta o falla un paso. La primera compilación requiere acceso
a crates.io y recursos suficientes para TFHE.

Sin Node, desde esta carpeta:

```sh
rustc --version
cargo generate-lockfile
cargo test --release --locked -- --test-threads=1
printf '255 255' | cargo run --release --locked -- --add-stdin
```

Resultado esperado del último comando: `sum` igual a 510 y `verified` igual a true.
En v17 se retiraron los modos heredados que recibían bits y bytes privados como
argumentos de línea de comandos. No pase secretos en `--circuit` ni como dos
argumentos posicionales: ahora se rechazan antes de generar llaves.
Este es un resultado esperado, **no un resultado ejecutado en esta entrega**.

## Límites y pendientes

API Rust directa; todavía no sustituye automáticamente la acción educativa #89
del registro JavaScript. El demostrador crea claves efímeras y no las escribe.
No hay aún protocolo remoto, almacenamiento de claves, rotación ni serialización
de ciphertexts. El llamador debe usar claves y ciphertexts compatibles: el
evaluador no autentica su procedencia ni detecta una clave equivocada. Tampoco
prueba que un servidor remoto haya evaluado correctamente el circuito.

El circuito y su tamaño son públicos. La implementación guarda los wires en
memoria y aplica límites finitos: 4096 entradas, 1 000 000 compuertas y 4096
salidas; alcanzar esos límites puede exigir mucha memoria. No es una garantía
de capacidad ni de seguridad de producción. Falta ejecutar y revisar este
backend antes de acreditar su funcionamiento.

Fuente de API consultada: https://docs.rs/tfhe/latest/tfhe/boolean/index.html
(mostraba versión 1.8.1 en la consulta). Licencia y condiciones de la dependencia
deben revisarse al distribuirla: https://github.com/zama-ai/tfhe-rs
