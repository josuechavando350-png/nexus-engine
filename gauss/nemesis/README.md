# Némesis dentro de GAUSS — integración en curso, NO CERTIFICADA

El PR #449 incorpora un puente `gauss:nemesis` que no reemplaza ni infla los 1.000 operadores de GAUSS. Rust/Cargo 1.98.1 funcionan en GitHub Actions y el motor #89 ejecutó compuertas TFHE booleanas reales: 5 pruebas Rust aprobadas en el run 35746029691; suma cifrada 255+255=510 y circuito [true,true,false]. El puente nativo exige SHA-256 confiable, copia los bytes verificados a una ruta privada antes de ejecutar y rechaza resultados inconsistentes. El run 35750069495 pasó `rust-native` y `gauss-coexistence`, pero `gauss-integration` falló correctamente por ausencia de la fuente completa.

## Transferencia desde teléfono, un único archivo

El ZIP `GAUSS_NEMESIS_v19_fuente_para_subir_GitHub_NO_CERTIFICADO.zip` contiene **297 archivos** bajo `gauss/nemesis/engine/`: la versión v17 íntegra, con 100 módulos fuente JS, 31 pruebas y 130 ejemplos. SHA-256 del ZIP: `dfb28dd86060dc31edae1b930a208adabb1c66606e26da88a49790fdbf5884c6`.

Subir el ZIP, **sin descomprimir ni renombrar**, a `gauss/nemesis/import/GAUSS_NEMESIS_v19_fuente_para_subir_GitHub_NO_CERTIFICADO.zip` en la rama `feat/gauss-nemesis-rust-integration` del repositorio `josuechavando350-png/nexus-engine` (no a `main`). El workflow `.github/workflows/gauss-nemesis-source-import.yml` se ejecuta con ese único cambio: verifica SHA256 exacto y rutas, importa el código, verifica `source-lock.json` y ejecuta suite JS, smoke y pruebas del puente. Solamente si todo pasa hace un commit con los archivos originales en esa rama. El bot no sube ni certifica código alterado. Si la subida o los permisos de escritura fallan, inspeccionar el log y no fusionar.

**Todavía no se ha subido ese ZIP a GitHub.** Este repositorio contiene el importador, la API nativa y el workflow, no la fuente completa de los 100. La importación tampoco sustituye un pase CI sobre el SHA final, una revisión de seguridad o el cumplimiento del alcance completo.

## Cierre pendiente

1. Subir e importar el ZIP y verificar las pruebas de GAUSS + Némesis en la misma revisión.
2. Implementar y verificar todo el alcance original, en particular #81 firma por isogenias, #89 seguridad de producción y #95 ceremonia y prueba Groth16 real. `tfhe = 1.8.1` es una dependencia Rust externa.
3. Fusionar PR #449 **solo cuando** estén completos los cambios declarados y todas las comprobaciones obligatorias estén verdes. Los 100 ejemplos coincidentes no acreditan 100 motores terminados.
