# LEIBNIZ / segundo bloque: semántica contrastable

`finite_model.rs` es código Rust nativo de biblioteca, no un resultado pregrabado: enumera exhaustivamente funciones de tipos simples sobre dominios finitos completos; comprueba tipos y usa límites de cardinalidad y trabajo. `hol-semantic-oracle.rs` contiene once pruebas independientes de la derivación sintáctica.

La ejecución `LEIBNIZ first- and second-block Rust validation` copia estos dos archivos al crate aislado, exige exactamente 200 pruebas aprobadas incluyendo las 189 anteriores, compila en Rust estable sin dependencias, ejecuta Clippy estricto y benchmarks, y publica las fuentes reconstruidas. Consulta `BLOCK2_FORMAL_VALIDATION.md` para las diferencias entre un contraejemplo semántico real, una prueba lógica y una comprobación acotada. La suite demuestra el alcance probado, NO el 50% de la suite universal ni una conexión activa con NEXUS/GAUSS.
