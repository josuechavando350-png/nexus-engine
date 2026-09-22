# Evidencia del segundo bloque

El comprobador de deducciones (`src/hol.rs`) y el intérprete de modelos finitos estándar (`src/finite_model.rs`) comparten únicamente los tipos sintácticos `Expr` y `Ty`; el segundo no llama al primero para producir sus resultados. La suite de aceptación exige ambos resultados por separado. En modelos finitos completos, `D_(σ→τ)` tiene exactamente `|Dτ|^|Dσ|` funciones; cualquier exceso de límites produce error, jamás una declaración de validez.

Las declaraciones sobre el 50 % global solo podrán realizarse después de definir y certificar contra un manifiesto medible de funciones de LEIBNIZ, lo que el PDF original no suministra. Este bloque prueba una porción formal del núcleo y no atribuye al código disponible las funciones de Gateway, GAUSS, ZK ni los demás motores. No se altera `main`.
