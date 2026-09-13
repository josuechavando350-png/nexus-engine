# NEXUS Engine — auditoría y cierre real

## Alcance y fuentes fijadas

- Repositorio: `josuechavando350-png/nexus-engine`.
- Baseline auditado para el inventario: `main@4e7ace3da7776d6559f646c08a3ae70257f7078b`.
- Head auditado para el cierre: `codex/auditar-pr-#85-sin-mergear@4f0ea2abcbc7784420caeeb1d5d91fc09882b4bc`.
- Comparación realizada contra `main@4e7ace3d`: la PR #86 concentra en un
  commit el estado funcional de #85 y el cierre posterior. La comparación de
  árboles `git diff 43a83e86..4f0ea2ab` identifica 19 rutas de cierre; #86 no
  desciende de #85, aunque parte del mismo baseline.

El remoto se configuró como `https://github.com/josuechavando350-png/nexus-engine.git`, el fetch terminó correctamente y `git cat-file -t 43a83e...` devolvió `commit`. No se hizo merge ni se usó contenido de `nexus-experience-engine`.

## Seguimiento de cierre solicitado

### 1. Build completo

**PASS EN CI SOBRE EL SHA EXACTO `4f0ea2ab`.**

GitHub Actions completó con `success` los cuatro workflows disparados por la
PR #86: Baseline Validation (incluidos Web reproducible build, Rust locked
workspace y optional adapters), Full Validation, H07 Clean-Room Operability y
Real Browser Capture Validation. Los pasos `Validate workspace`,
`Hermetic deterministic build`, `Rust release build`, `Format, lint, test and
release build`, `Build and validate independently` y
`Assert clean build and evidence identity` terminaron con success.

Runs observados:

- Baseline Validation: `32652551572`.
- Full Validation: `32652551560`.
- H07 Clean-Room Operability Proof: `32652551575`.
- Real Browser Capture Validation: `32652551579`.

La limitación descrita a continuación pertenece exclusivamente a intentos
interactivos anteriores y ya no bloquea el cierre:

Se ejecutó `pnpm build` sobre el head exacto, primero con Node 20.20.2 y
después con el Node 24.15.0 ya instalado mediante `nvm`. Node 20 produjo el
warning de engine esperado. Node 24 eliminó ese warning, por lo que la versión
de Node no explica la terminación.

En ambos intentos el proceso fue terminado externamente, sin error de Next.js,
sin código de salida y antes de que el shell pudiera escribir el archivo de
exit status. El segundo intento se ejecutó así para distinguir un fallo normal
de una terminación del entorno:

```sh
(pnpm build > /tmp/pr85-build24.log 2>&1; printf '%s' "$?" > /tmp/pr85-build24.rc)
```

`/tmp/pr85-build24.rc` no llegó a existir. La última salida reproducible con
Node 24 fue:

```text
NEXUS asset guard passed: 8 app(s), 0 declared public asset reference(s) verified.
NEXUS hermetic input policy passed for 666 tracked file(s).
> node scripts/verify-deterministic-build.mjs
▲ Next.js 15.5.23
Creating an optimized production build ...
```

Otro intento llegó a `Compiled successfully`, generó las páginas estáticas y
alcanzó `Collecting build traces ...` antes de la misma terminación externa.
No hubo `ELIFECYCLE`, excepción, señal reportada por pnpm ni diagnóstico de
memoria; el host tenía aproximadamente 16 GiB disponibles. Por tanto no se
declara ni PASS ni FAIL del repositorio: la ejecución es **INCONCLUSIVE** por
el límite del runner interactivo.

### 2. Duplicación de delivery certification

**RESOLVED LOCALLY.** Los contratos no eran equivalentes y no debían fusionarse:

- Quality evalúa que el conjunto obligatorio de gates, Visual Judge, Red Team
  y repair/rejudge haya pasado. Ahora vive en
  `packages/quality/quality-gate-certification.ts`, expone
  `certifyQualityGatesForDelivery` y emite autoridad
  `NEXUS_QUALITY_GATE_CERTIFICATION_V1`.
- Evidence verifica criptográficamente el bundle, su scope, revisión, sources
  y samples. Ahora vive en
  `packages/evidence/signed-evidence-certification.ts`, expone
  `certifySignedEvidenceForDelivery` y emite autoridad
  `NEXUS_SIGNED_EVIDENCE_CERTIFICATION`.

Se actualizaron exports, build assertions, consumidores y tests. Ya no existe
ningún archivo llamado `delivery-certification.ts` ni una función pública
ambigua llamada `certifyDelivery`.

### 3. Gates estáticos e invariantes V8

**RESOLVED FOR THE IDENTIFIED FALSE COVERAGE.** Se eliminaron los tests que
certificaban V4–V6 leyendo palabras del fuente y se retiraron del test V7 las
comparaciones de strings entre Rust y TypeScript. Las propiedades que sí tienen
observación ejecutable quedan ligadas a sus tests Rust/TypeScript reales. Las
que no tienen conformance observable están registradas como
`INVARIANT_NOT_ENFORCEABLE`, con la razón, en
`docs/INVARIANT_ENFORCEMENT.md`.

La cobertura útil de V8 queda recuperada por ejecución: Vault prueba digest,
tamaño, identidad inmutable, lineage, derechos y scope; Memory prueba autoridad
evidence-only, retention, supersession, scope y fallos; creative evidence prueba
identidad scope/time y fallo explícito del sink; benchmark prueba workloads,
raw samples, determinismo y entradas inválidas. Las antiguas afirmaciones sobre
redacción de planes, tecnologías opcionales y madurez se marcan explícitamente
no-enforceable y no vuelven a convertirse en gates Markdown.

### Señal local de una sola app

`pnpm --filter @nexus/reference-alfil build` se ejecutó con Node 24.15.0. Next
compiló correctamente, completó typecheck, generó las cuatro páginas estáticas
y llegó a `Collecting build traces ...`. El runner volvió a terminar la sesión
antes de entregar exit status. Esto es consistente con un límite temporal del
runner, incluso para una sola app; no se declara PASS completo.

### Disposición actual de #85 y #86

**#85 SUPERSEDED BY #86.** Ambas PR parten de `main@4e7ace3d`. #85 contiene 19
commits hasta `43a83e86`; #86 concentra el estado resultante y el cierre nuevo
en `4f0ea2ab`. #86 no es descendiente Git de #85, por lo que no preserva esos
19 commits como historial individual, pero su árbol incorpora ese trabajo y lo
reemplaza deliberadamente en las rutas de cierre (scene model, separación de
certificaciones y retirada de checks estáticos no ejecutables). No es necesario
mergear #85 antes de #86 para conservar el estado funcional auditado.

El head de #86 está subido y sus cuatro workflows terminaron verdes. La
disposición coherente es cerrar #85 sin mergear y someter exclusivamente #86 a
aprobación humana. Este informe no constituye una aprobación ni autoriza merge.

## Fase 1 — auditoría de #85

**Resultado: REVIEW_REQUIRED. #85 mejora la integridad, pero no está lista para aprobar.**

### Hallazgos solicitados

| Comprobación | Evidencia en `43a83e86` | Resultado |
| --- | --- | --- |
| Cuatro `NEXUS_V10_*_PASSED` | Búsqueda exacta en workflows, scripts, packages y tests: cero coincidencias. `verify-workflow-evidence-claims.mjs` además rechaza claims ambientales autoafirmados. | **PASS** |
| Signer Ed25519 accidental del Passport | `scripts/passport-sign.mjs` y `scripts/passport-verify.mjs` fueron eliminados, y los scripts de package desaparecieron. `docs/SIGNING_DECISION.md` selecciona cosign keyless pero no lo implementa. | **PASS para Passport: desactivado / NOT_IMPLEMENTED** |
| Ed25519 restante | Sigue siendo código ejecutable en `packages/evidence/index.ts`, sus tests y el feature del protocolo Edge. No es firma de Quality Passport, pero #85 no “elimina Ed25519” globalmente. | **SCOPE CLARIFICATION** |
| V3 | `v3-gates` permanece; combina cargo real con gates estáticos. | **ACTIVE, con deuda estática** |
| V4–V10 y `v10-final-readiness` | Se eliminan los scripts V4–V10, incluido final-readiness, y sus package scripts. | **RETIRED, no certificados** |
| Gates por Markdown/grep/`existsSync` | Se retiran los gates históricos V4–V10, pero `quality-gates.mjs`, `v3-architecture-gates.mjs` y varios tests aún aprueban invariantes leyendo texto fuente, buscando strings o comprobando existencia. Ejemplos: CSP/cabeceras en `quality-gates.mjs`; invariantes y docs en `v3-architecture-gates.mjs`; V7 y runtime en tests. | **FAIL / INCOMPLETE** |
| Migración de invariantes útiles | Se añaden `tests/runtime-invariants.test.ts` y se reduce V7, pero esos tests siguen inspeccionando strings en Rust; V8 se borra sin reemplazo equivalente y V4–V6 conservan tests mínimos de fuente, no comportamiento. | **FAIL / INCOMPLETE** |
| `test:browser` real en CI | `v8-pr-validation.yml` instala Chromium/WebKit y ejecuta `pnpm test:browser`; H07 hace lo mismo. `quality-browser-capture.yml` ya captura y valida artefactos reales. | **PASS (definición CI)** |
| Documentos V2–V10 en raíz | El baseline contiene 23 archivos raíz que coinciden con `NEXUS_*`, `THIS_BUILD` o `UPLOAD_FIRST`: 11 movidos a `archive/history`, 11 eliminados, queda `NEXUS_MASTER_STATE.md`. La cifra verificable es 22 limpiados, no 25. | **PASS para los 22 observados; discrepancia de conteo** |
| Duplicación delivery certification | Persisten `packages/quality/delivery-certification.ts` y `packages/evidence/delivery-certification.ts`; sus SHA-256 difieren y representan contratos distintos con el mismo nombre. | **FAIL / UNRESOLVED** |

### Prueba ejecutada sobre el head

En worktree detached del head exacto:

- `pnpm install --frozen-lockfile`: completó, con warning porque el host usa Node 20 y el repo exige Node 24.
- `pnpm lint`: PASS.
- `pnpm typecheck`: PASS.
- `pnpm test`: PASS, 94 archivos y 520 tests.

No se interpreta ese verde como cierre de las deudas anteriores.

## Fase 2 — inventario de capacidades en `main@4e7ace3d`

Reglas de estado:

- **IMPLEMENTED**: contrato ejecutable, pruebas positivas/negativas relevantes y ejecución en CI.
- **PARTIAL**: existe una parte ejecutable y probada, pero falta una propiedad obligatoria o integración real.
- **MISSING**: no existe implementación ejecutable de la capacidad pedida.
- **CLAIM_ONLY**: hay nombres/documentación/manifests, pero no una capacidad verificable.

| CAPABILITY | IMPLEMENTATION (main) | TEST | CI EVIDENCE | STATUS |
| --- | --- | --- | --- | --- |
| Comparator / regresión visual | `scripts/ci-browser-quality.mjs` usa ImageMagick `identify` + `compare`, calcula píxeles cambiados y falla sobre umbral. Sin baseline devuelve `NOT_TESTED`, no PASS. | Ejercitado indirectamente por el workflow; no hay unit test dedicado al comparator ni fixture roto permanente. | `.github/workflows/quality-browser-capture.yml` produce capturas y ejecuta el evaluador. | **PARTIAL** |
| Overlap/overflow geométrico | `packages/capture/mutation-runner.ts` mide `scrollWidth - innerWidth`; `packages/quality/mutation-evaluator.ts` falla por overflow horizontal. No calcula intersecciones de cajas, contenido fuera de sección, visual sobre texto ni texto cortado. | `packages/capture/tests/mutation-runner.test.ts`; tests del mutation evaluator. | Browser capture workflow ejecuta browser tests. | **PARTIAL** |
| Asset-integrity guard | No hay manifest verificable con existencia + tamaño + MIME + dimensiones + SHA-256. `quality-gates.mjs` solo comprueba estructura y strings; el pipeline valida provenance declarada, no todos los bytes de assets entregados. | No existen los cuatro negativos exigidos (faltante, truncado, sustituido, hash incorrecto). | Ningún job de main ejecuta un guard fail-closed equivalente. | **MISSING** |
| Identificación inequívoca de cliente | Hay `projectId` en contratos y apps en workspace, pero no contrato estructurado que clasifique `CLIENT`, `REFERENCE`, `PROBE`, `SEED`; la selección depende de listas/rutas. | No hay test de descubrimiento inequívoco de un cliente real. | Ningún workflow certifica esa clasificación. | **MISSING** |
| Design DNA ejecutable | `packages/creative/design-dna.ts` valida Project Design DNA aprobado; `packages/experience/dna.ts` y el pipeline sintetizan DNA y lo pasan al emitter/generador. | `packages/creative/tests/design-dna.test.ts`, tests de Experience y `scripts/nexus-client-pipeline.test.ts`. | Workflows ejecutan `pnpm test`; el pipeline completo no es un gate universal de cada app. | **PARTIAL** |
| Scene model derivado por el motor | El pipeline produce un plan/generación, pero no existe IR visual con schema que derive layout intrínseco de DNA + contenido + assets, provenance y mediciones de crecimiento. | No hay tests de scene model ni de crecimiento intrínseco. | Ninguna. | **MISSING** (`NEXUS_CAPABILITY_MISSING: VISUAL_SCENE_MODEL`) |
| Adversarial probes | Mutation runner ejecuta long-copy, missing-media, 390px, zoom 200% y reduced-motion con navegador; red-team valida cobertura/evidencia. No incluye el fixture roto permanente ni toda la geometría requerida. | `mutation-runner.test.ts`, mutation evaluator y red-team tests. | `quality-browser-capture.yml` ejecuta browser tests. | **PARTIAL** |
| Shadow Mode | No hay `shadow-mode.mjs`, baseline de shadow ni contrato de descubrimiento en main. | Ninguna. | Ninguna. | **MISSING** |
| Build hermético determinista | Hay IDs/digests deterministas y `assert-clean-build`, pero el build de workspace no verifica inputs herméticos ni reproduce dos builds y compara artefactos. | No hay test de reproducibilidad integral del build. | Workflows ejecutan `pnpm build`, no una prueba hermética. | **MISSING** |
| Caché content-addressed | No existe caché de build CAS en main. IDs content-addressed de evidencia no equivalen a caché de compilación. | Ninguna. | Ninguna. | **MISSING** |
| Decision provenance | Ingesta, generation digest, craft provenance y evidence records conservan hashes/provenance; no existe un decision trace integral que conecte cada decisión del cliente a input, regla, output y revisión. | `packages/creative/tests/craft-provenance.test.ts`, evidence y pipeline tests. | `pnpm test` en workflows, sin artefacto de decision trace por entrega. | **PARTIAL** |
| Quality Passport | `packages/quality/quality-passport.ts` valida scope, SHA, checks y evidencia; `ci-browser-quality.mjs` produce passport ligado a artefactos y revisión. | `packages/quality/tests/quality-passport.test.ts`; visual-judge tests. | `quality-browser-capture.yml` genera y sube el passport con evidencia real. | **IMPLEMENTED** |
| Field RUM | `packages/capture/field-rum.ts` valida/agrega muestras y p75, pero no existe colector desplegado, ingestión autenticada ni evidencia CI de datos de campo reales. | `packages/capture/tests/field-rum.test.ts`. | Unit tests solamente; ningún job demuestra captura de campo. | **PARTIAL** |
| Browser capture real | `packages/capture/playwright-adapter.ts` lanza Chromium/WebKit, visita HTTP(S), captura PNG y artefactos a11y/genome/performance. | `packages/capture/tests/playwright-adapter.test.ts`, APCA y mutation runner browser tests. | `quality-browser-capture.yml` instala motores, levanta targets, captura y verifica PNG/JSON ligados al SHA. | **IMPLEMENTED** |

## Matriz de capacidades en `4f0ea2ab` (head de #86)

Esta segunda matriz mide el código ejecutable de
`codex/auditar-pr-#85-sin-mergear`, no anticipa el estado de `main` y no
convierte la descripción de #86 en evidencia. La columna CI refleja los runs
verdes sobre el SHA exacto `4f0ea2ab`, no el success anterior de `43a83e86`.

| CAPABILITY | IMPLEMENTATION (`4f0ea2ab`) | TEST | CI EVIDENCE OBSERVADA | STATUS |
| --- | --- | --- | --- | --- |
| Comparator / regresión visual | Conserva el pixel diff real de `ci-browser-quality.mjs`; no incorpora comparator geométrico ni fixture roto permanente. | Browser-quality/capture, sin test unitario dedicado al comparator. | `quality-browser-capture.yml`. | **PARTIAL** |
| Overlap/overflow geométrico | Adversarial matrix y mutation runner miden overflow horizontal; no calculan intersecciones, clipping de texto o containment de sección. | `adversarial-matrix.test.ts`, mutation tests. | Browser workflows ejecutan ambas superficies. | **PARTIAL** |
| Asset-integrity guard | `verify-declared-assets.mjs` falla por faltante, directorio o archivo vacío, pero no valida MIME, dimensiones, tamaño mínimo ni SHA-256 manifestado. | `verify-declared-assets.test.mjs` solo cubre presente/faltante. | `pnpm lint` y `pnpm build` llaman `verify:assets`. | **PARTIAL** |
| Identificación inequívoca de cliente | `client-fleet.mjs` exige `nexus.clientProject=true`, pero también excluye proyectos por prefijos del nombre de carpeta. No es todavía puramente estructurado. | `client-fleet.test.mjs`. | Unit suite; Shadow consume el descubrimiento. | **PARTIAL** |
| Design DNA ejecutable | Sin cambio material: validación y generación existen, pero no son gate universal por app. | DNA, Experience y pipeline tests. | `pnpm test`. | **PARTIAL** |
| Scene model derivado por motor | `visual-scene-model.ts` deriva una IR intrínseca de DNA + plan + contenido + assets + entorno y el pipeline la produce antes de generar código. | Tests positivos, provenance determinista y matriz adversarial de crecimiento. | Baseline, Full Validation, H07 y Browser Capture completaron con success sobre `4f0ea2ab`. | **IMPLEMENTED** |
| Adversarial probes | `adversarial-matrix.ts` ejecuta nueve probes reales, incluidos texto doble, heading 40, media ausente/vertical, zoom, teclado y reduced motion. Falta la geometría obligatoria para detectar todas las colisiones silenciosas. | Test browser positivo de la matriz. | Incluido en `test:browser`. | **PARTIAL** |
| Shadow Mode | Ejecuta build sin deploy, descubre clientes, hashea scenes/artefactos y compara baseline. Sin cliente real manifestado devuelve `NOT_TESTED`; no hay evidencia operacional todavía. | `client-fleet.test.mjs`; no hay E2E de Shadow con build real. | Script disponible, no job con cliente real. | **PARTIAL** |
| Build hermético determinista | Verifica inputs y reproduce/canonicaliza dos builds; está integrado en `pnpm build`. | `build-core.test.mjs`, deterministic build-id test. | Full Validation completó `Hermetic deterministic build`; Baseline completó `Validate workspace` sobre `4f0ea2ab`. | **IMPLEMENTED** |
| Caché content-addressed | `build-core.mjs` deriva key de inputs/dependencias y verifica hashes al restaurar; corrupción invalida el entry. | `build-core.test.mjs` cubre restore y tampering. | Usada por build workspace. | **IMPLEMENTED** |
| Decision provenance | Contrato y script validan decisiones y las ligan al Passport; falta evidencia de una entrega cliente real. | `decision-trace.test.ts`. | Unit suite y browser passport consumer. | **PARTIAL** |
| Quality Passport | Mantiene evidencia real y añade `decisionTraceDigest`. | Passport, decision trace y browser quality tests. | Browser capture workflow genera artefacto. | **IMPLEMENTED** |
| Field RUM | Añade resumen de flota y anomaly report, pero sigue sin colector/ingestión de campo desplegado. | Field RUM y fleet anomaly tests. | Unit suite solamente. | **PARTIAL** |
| Browser capture real | Playwright Chromium/WebKit y matriz adversarial producen PNG/JSON ligados al SHA. | Browser tests reales. | Workflows instalan browsers y ejecutan `test:browser`. | **IMPLEMENTED** |

## Consecuencias para las fases siguientes

1. Fase 3 debe reemplazar los gates críticos restantes que inspeccionan texto/configuración por pruebas de respuesta, comportamiento o artefactos.
2. Fase 4 no parte de cero: existe pixel diff, pero falta el comparator geométrico y su fixture negativo permanente. Estado operativo: `NEXUS_CAPABILITY_MISSING: VISUAL_REGRESSION_GEOMETRY`.
3. Fases 5–7 siguen bloqueadas por capacidades MISSING señaladas en la matriz.
4. Fase 8 requiere cambios amplios de seguridad y un servidor real por app; no se inició en este commit de auditoría.
5. Fase 9 permanece `PASSPORT_SIGNING: NOT_IMPLEMENTED`; la decisión cosign keyless no cuenta como implementación.

## Fase 6 — Visual Scene Model

**IMPLEMENTED; CI PASS SOBRE `4f0ea2ab`.**

`packages/experience/visual-scene-model.ts` define schema V1, tipos de contenido,
assets, entorno, nodos y stages. La derivación produce únicamente sizing
intrínseco por contenido, aspect ratio o fallback; la política es
`blockSizing=INTRINSIC`, `contentGrowth=REFLOW` y `clipping=FORBIDDEN`. El modelo
no ofrece `height`, `overflow:hidden` ni otra vía para representar 598/585 como
altura rígida única.

Cada stage se coloca después del block size intrínseco anterior. Texto calcula
líneas desde ancho disponible, font metrics semánticas y zoom; media deriva su
tamaño del aspect ratio; media ausente reserva un fallback no colapsado. En
390px la derivación usa una columna. Reduced motion cambia la estrategia de
movimiento a `none` sin alterar geometría.

El modelo conserva provenance SHA-256 sobre project, DNA, plan, contenido,
assets y entorno, junto con content IDs y asset digests. El client pipeline lo
deriva obligatoriamente después de content readiness y antes del emitter, lo
valida contra overlap silencioso y liga su digest al gate GENERATION.

La suite adversarial cubre determinismo, ausencia de clipping expresable,
texto ×2, heading exacto de 40 caracteres, imagen ausente, imagen vertical,
390px, zoom 200% y reduced motion. En los casos de crecimiento se exige aumento
del block size y flujo continuo sin stages superpuestos.

## Trabajo de este commit

Además del informe, esta rama separa los contratos de certificación, registra
honestamente la enforceability de invariantes e implementa Visual Scene Model
dentro de `@nexus/experience`. No se firmó un Passport y no se hizo merge.
