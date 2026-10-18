# 12 — Incrementalidad Geo-Holdout

SEO Profesional #12 reutiliza el CORTEX #12 canónico `packages/ontology/cortex/geo-holdout` en lugar de crear un segundo motor estadístico.

## Qué hace

- preregistra diseños geo-holdout estratificados;
- persiste diseño y análisis en el registro SQLite durable de CORTEX #12;
- conserva el control durable `ACTIVE / OBSERVE_ONLY / KILLED`;
- liga cada experimento a `operatorWebsiteOrigin + googleAdsCustomerId` mediante un `scopeDigest` SHA-256;
- convierte el `experimentId` durable a un namespace `seo12:<scope>:<experimentKey>` para impedir reutilización accidental entre cuentas/orígenes;
- hereda la verificación de baseline, digest del diseño, tamaños mínimos por brazo y análisis difference-in-differences con incertidumbre Welch/intervalo 95%;
- traduce el resultado únicamente a `ALLOW_OPTIMIZATION`, `HOLD` o `BLOCK_REGRESSION`.

## Semántica causal

`POSITIVE` significa que el intervalo 95% del incremental delta quedó completamente por encima de cero bajo el diseño registrado; únicamente ese estado puede habilitar la optimización exact-match #2 en el master.

`INCONCLUSIVE` produce `HOLD`. No se promueve a éxito, no habilita mutación y no se presenta como evidencia causal positiva.

`NEGATIVE` produce `BLOCK_REGRESSION` y bloquea la optimización.

El módulo no promete causalidad universal, lift futuro, ranking ni ingresos. La validez depende del diseño, la calidad de los outcomes, la estabilidad de los supuestos y el alcance de los geos incluidos.

## Producción

`createSqliteSeoGeoIncrementalityRuntime()` exige una ruta SQLite absoluta y compone directamente `SqliteGeoHoldoutControl` + `SqliteGeoExperimentRegistry`. El control arranca fail-closed como `KILLED` hasta que el operador lo active explícitamente. En `OBSERVE_ONLY` y `KILLED` el registro durable bloquea mutaciones.

No se almacenan secretos, emails, teléfonos, IPs ni identificadores de usuario. Los experimentos trabajan con IDs de geo y outcomes agregados.

## Conectividad

El master conecta:

- `#4 -> #12 / VERIFIED_EXPERIMENT_OPERATOR_IDENTITY`: el origen del experimento debe ser el mismo origen canónico LocalBusiness y el customer de Google Ads debe coincidir con el core #1/#2.
- `#12 -> #2 / INCREMENTALITY_GATED_OPTIMIZATION`: el master solo delega a `optimizeExactMatches()` cuando el análisis durable de #12 produce `ALLOW_OPTIMIZATION`.

Por tanto #12 no es un dashboard aislado: participa en una ruta real de decisión antes de la mutación Google Ads existente.
