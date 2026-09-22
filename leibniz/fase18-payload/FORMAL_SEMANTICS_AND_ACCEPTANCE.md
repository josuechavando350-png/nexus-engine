# LEIBNIZ: semántica formal y aceptación del núcleo aislado

## Hito 7: sistema formal **definido**, no enumeración finita

La implementación `src/hol.rs` es un comprobador de certificados de deducción para **teoría clásica extensional de tipos simples (STT)**. Esta definición establece el lenguaje, la interpretación y las reglas; no afirma que el programa decida la validez de cualquier fórmula ni que implemente todas las lógicas de orden superior concebibles.

### Sintaxis y tipos

Los tipos son `ι` (individuos), `o` (proposiciones) y `σ → τ` cuando `σ,τ` son tipos. Su profundidad es arbitraria en la definición matemática; la implementación rechaza árboles de tipos que superen el límite de recursos. Los términos son variables y constantes tipadas, abstracción `λx:σ.t`, aplicación `f t`, `⊥`, `φ ⇒ ψ`, `φ ∧ ψ`, `∀x:σ.φ`, `∃x:σ.φ` e igualdad `s =_σ t`. Conectivas y cuantificadores producen `o`; la igualdad exige el mismo tipo en ambos lados. Los nombres ligados deben ser no ambiguos y la sustitución evita captura. Ningún predicado debe pertenecer a una lista declarada para poder cuantificar sobre él en `hol`.

### Interpretación estándar/plena

Un modelo `M` asigna a `ι` **cualquier conjunto no vacío** `D_ι` (finito o infinito), a `o` el conjunto `{false,true}`, y a cada tipo funcional **todo el espacio** `D_(σ→τ) = {f | f : D_σ → D_τ}`. Las constantes tienen una interpretación tipada y la asignación `ρ` asigna a cada variable un elemento de su dominio. Por inducción estructural: `⟦x⟧ρ = ρ(x)`; `⟦c⟧ρ = I(c)`; `⟦λx.t⟧ρ(a) = ⟦t⟧ρ[x↦a]`; `⟦f u⟧ρ = ⟦f⟧ρ(⟦u⟧ρ)`; `⟦⊥⟧ρ = false`; implicación y conjunción son las operaciones booleanas clásicas; `⟦s=t⟧ρ` es identidad en `D_σ`; `⟦∀x:σ.φ⟧ρ = true` si y solo si para **cada** `a ∈ D_σ`, `⟦φ⟧ρ[x↦a] = true`; `∃` usa **algún** `a ∈ D_σ`. Por tanto `∀P:ι→o` cuantifica sobre **todos** los predicados de individuos; `∀F:(ι→o)→o` cuantifica sobre predicados de predicados. Ninguno se sustituye semánticamente por el catálogo finito del motor Horn.

### Interpretación general/Henkin

Para modelos generales, `D_(σ→τ)` puede ser un subconjunto no vacío de funciones `D_σ → D_τ` que contiene la interpretación de cada término `λ` bien tipado bajo toda asignación admitida; `D_o` sigue siendo los dos valores booleanos y la igualdad es identidad. Cuantificadores recorren el dominio asignado al tipo. Los modelos plenos son casos particulares de los generales. El cálculo implementado es un **comprobador de deducciones**, y sus reglas son válidas en ambas clases de modelos bajo estas condiciones.

### Reglas efectivamente comprobadas

`Hypothesis` cita únicamente una premisa explícita; `ImpIntro` descarga una premisa añadida y `ImpElim` exige su antecedente demostrado. Se verifican introducción/eliminación de `∧`, `∀` y `∃`, con condiciones de variable propia; `FalseElim` exige demostración de `⊥`; igualdad reflexiva y sustitución requieren términos/predicados bien tipados y una premisa real; extensionalidad funcional requiere `∀x. f x = g x` demostrado y extensionalidad proposicional exige las dos implicaciones comprobadas; eliminación clásica exige demostración de doble negación. La comparación de términos usa equivalencia alfa y reducción beta con presupuesto. La aceptación exige una derivación completamente comprobada, objetivo bien tipado, premisas reveladas y presupuesto no agotado.

**Alcance lógico:** corrección respecto de las reglas descritas, **no** prueba mecanizada de la corrección del propio verificador. No se afirma completitud efectiva para semántica plena: la validez de orden superior bajo semántica estándar no tiene un cálculo recursivamente axiomatizable que sea a la vez correcto y completo. Tampoco se implementan tipos dependientes, selección de axiomas externos, búsqueda universal de pruebas, ZK, ingestión ni conexión operativa con GAUSS. Una prueba relativa a premisas no acredita que estas sean verdaderas en el mundo.

## Hito 8: aceptación ejecutable de los ocho entregables del núcleo

El hito 8 de la bitácora original es **compilación Rust sin conexión, pruebas, lint estricto y benchmarks**, no una nueva función matemática. Su aceptación exige, en **una única ejecución correspondiente al mismo commit**:

1. Recuperación íntegra del código y de `src/hol.rs` con SHA-256 verificado, sin aceptar archivos corruptos.
2. `cargo fmt --all -- --check` y `cargo test --all-targets --offline`, con **189 pruebas como mínimo**, cero fallidas e ignoradas. La suite incluye las 152 anteriores, 28 pruebas HOL, cuatro pruebas de aceptación de extremo a extremo y cinco regresiones adicionales de cuantificación no enumerada.
3. `cargo clippy --all-targets --offline -- -D warnings`, `cargo build --release --offline` y las dos ejecuciones reales de ejemplos (`benchmark 250 3` y `graph_scale 8 16 24`).
4. Publicación del paquete reconstruido de código fuente legible como artefacto de esa misma ejecución. La salida de rendimiento es una medición de esos ejemplos, no una promesa de rendimiento universal.

Los **ocho hitos** se refieren exclusivamente a los ocho entregables enumerados en la bitácora de `LEIBNIZ_PLAN.md` (modelos, grafo tipado, inferencia Horn, verificación independiente, persistencia local, semántica de unidades/tiempo, cálculo STT definido aquí, y certificación Rust). Que ocho hitos pasen sus pruebas **no demuestra que equivalgan al 25 % del manifiesto universal** ni que LEIBNIZ esté integrado en NEXUS. Esa extrapolación requiere un inventario y pruebas de aceptación propios del producto universal; no se cambia el denominador para inventar progreso.
