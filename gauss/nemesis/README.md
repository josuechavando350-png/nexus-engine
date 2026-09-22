# Némesis dentro de GAUSS — integración en curso, NO CERTIFICADA

Se conserva el alcance original y código del proyecto Némesis v17. Este PR prepara la API `runGaussNemesis(id, input)`, los tests y un runner de Rust; **el código completo de Némesis todavía no está incorporado en esta rama**. Debe integrarse en `gauss/nemesis/engine/` antes de fusionar este PR. El puente falla explícitamente cuando falta: no usa implementaciones falsas ni reutiliza motores de GAUSS para simular el inventario.

La frontera usa un namespace distinto para no sobrescribir ni inflar el registro de 1000 operadores de GAUSS. El registro de Némesis contiene #02–#100; #01 usa `verifyFiniteSystem`. Que sus 100 ejemplos ejecuten no acredita que sus motores cumplan completamente su alcance original. #81 (firma por isogenias), #89 (evidencia Rust TFHE) y #95 (ceremonia y prueba real Groth16) conservan pendientes.

## Validación obligatoria antes de fusionar

```bash
node --test gauss/nemesis/tests/*.test.mjs
node gauss/nemesis/engine/scripts/smoke-100.mjs
cargo test --release --manifest-path gauss/nemesis/engine/native/fhe/Cargo.toml
```

La workflow `gauss-nemesis-rust.yml` instala Rust/Cargo en un runner GitHub Linux sin computadora del usuario. Falla si el código completo no está incorporado. No se debe llamar instalado o probado el backend FHE hasta tener registro de ejecución del job.
