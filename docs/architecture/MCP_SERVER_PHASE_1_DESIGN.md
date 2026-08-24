# NEXUS MCP remoto — diseño de Fase 1

**Estado:** propuesta para aprobación; no implementa un servidor ni herramientas.

## 1. Decisiones y límites

El servidor será una interfaz de control determinista sobre capacidades existentes del repositorio. No llama modelos, no incorpora dependencias de IA al motor y no convierte texto libre en hechos. Vive propuesto en `packages/mcp-server`, separado de `packages/core`, `packages/experience` y `runtime`. Consume APIs públicas de paquetes cuando existan y ejecuta adaptadores de repositorio explícitos cuando hoy sólo exista un script.

La primera versión usa MCP remoto mediante **Streamable HTTP** sobre HTTPS, con JSON-RPC/MCP en un endpoint `/mcp`. Un endpoint no autenticado `/healthz` sólo devuelve disponibilidad y versión, nunca estado del repositorio. Cada operación se ejecuta contra un checkout identificado; las mutaciones sólo se permiten en ramas con prefijo `nexus-mcp/`. No hay merge, deploy, push forzado, borrado de ramas ni acceso a producción.

El proceso necesita un único worker por checkout en v1. Las operaciones costosas se serializan y tienen timeout. Un resultado pertenece al `repository`, `branch` y `sourceSha` declarados; no se reutiliza como evidencia de otro SHA.

### Sobre de respuesta común

Todas las herramientas devuelven contenido estructurado, sin un resumen sustituto de la evidencia:

```ts
type ExecutionStatus = "PASS" | "FAIL" | "NOT_TESTED";

type ToolResult<T> = {
  schemaVersion: "1";
  tool: string;
  requestId: string;
  status: ExecutionStatus;
  repository: "josuechavando350-png/nexus-engine";
  branch: string | null;
  sourceSha: string | null;
  startedAt: string;
  finishedAt: string;
  data: T | null;
  evidence: Array<{
    kind: "git" | "github" | "command" | "file" | "artifact" | "capture";
    locator: string;
    sha256?: string;
    exitCode?: number;
  }>;
  errors: Array<{
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  }>;
};
```

Reglas del sobre:

- `PASS` exige que toda la operación solicitada terminó y que cada afirmación positiva referencia evidencia.
- `FAIL` significa que una comprobación ejecutada falló o que la petición fue inválida. No se disfraza un resultado parcial como éxito.
- `NOT_TESTED` significa que la comprobación no pudo ejecutarse; siempre incluye un error causal. Nunca se convierte en `PASS`.
- Los comandos reportan comando permitido, código de salida, duración y rutas de logs. Los logs y artefactos grandes se entregan como recursos MCP/URLs efímeras con SHA-256, no incrustados sin límite.
- Los valores desconocidos son `null` o una colección vacía acompañada por error; nunca se inventan.

## 2. Superficie de herramientas

### `nexus_status`

**Riesgo:** sólo lectura.

Entrada:

```ts
{
  includePullRequests?: boolean; // default true
}
```

Salida `data`:

```ts
{
  git: {
    branch: string;
    headSha: string;              // SHA completo
    detached: boolean;
    clean: boolean;
    changedPaths: string[];
    remoteUrl: string | null;
  };
  pullRequests: Array<{
    number: number;
    title: string;
    url: string;
    headBranch: string;
    headSha: string;
    baseBranch: string;
    draft: boolean;
    state: "OPEN" | "CLOSED" | "MERGED";
    mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
    ci: "PASS" | "FAIL" | "PENDING" | "NOT_TESTED";
    checks: Array<{
      name: string;
      status: "PASS" | "FAIL" | "PENDING" | "NOT_TESTED";
      conclusion: string | null;
      url: string | null;
    }>;
    redChecks: string[];
  }>;
}
```

Fuentes: `git` local y API de GitHub. Si GitHub no está disponible, los datos git pueden devolverse dentro de `data`, pero el resultado global es `NOT_TESTED` con `GITHUB_UNAVAILABLE`; no se afirma que no haya PRs. Errores: `NOT_A_GIT_REPOSITORY`, `GITHUB_AUTH_FAILED`, `GITHUB_RATE_LIMITED`, `GITHUB_UNAVAILABLE`, `CHECKOUT_CHANGED_DURING_READ`.

### `nexus_projects`

**Riesgo:** sólo lectura.

Entrada:

```ts
{
  includeArchived?: boolean; // default false; archive nunca es workspace activo
}
```

Salida `data`:

```ts
{
  projects: Array<{
    slug: string;
    path: string;
    packageName: string;
    workspaceMember: boolean;
    kind: "CLIENT" | "REFERENCE" | "PROBE" | "SEED" | "UNKNOWN";
    clientProject: boolean;
    evidence: {
      packageJsonPath: string;
      clientProjectDeclaration: true | false | null;
      classificationRule: string;
    };
  }>;
}
```

Clasificación determinista: `CLIENT` sólo si `package.json.nexus.clientProject === true`; `_experience-seed` es `SEED`; `reference-*` es `REFERENCE`; `v2-probe-*`/`probe-*` es `PROBE`; el resto sin declaración explícita es `UNKNOWN`, nunca cliente inferido. Errores: `WORKSPACE_MANIFEST_INVALID`, `APPS_DIRECTORY_MISSING`, `PROJECT_MANIFEST_INVALID`, `DUPLICATE_PROJECT_SLUG`.

### `nexus_project_new`

**Riesgo:** escritura confinada a rama; se implementa al final.

Entrada:

```ts
{
  slug: string; // kebab-case
  business: {
    name: string;
    industry: string;
    location: string;
    contact: {
      phone?: string;
      email?: string;
      website?: string;
      address?: string;
    };
    confirmedServices: Array<{ name: string; description?: string }>;
  };
  artDirection: {
    palette: Array<{ hex: string; role: string; rationale: string }>;
    typography: {
      display: string;
      body: string;
      rationale: string;
    };
    heroComposition: { direction: string; rationale: string };
    sectionRhythm: { direction: string; rationale: string };
    motion: { direction: string; reducedMotionBehavior: string; rationale: string };
    prohibitions: string[];
  };
  baseSha: string;
  branchName?: string; // si existe, debe empezar nexus-mcp/
  commitMessage?: string;
}
```

Todos los campos de dirección de arte son obligatorios, no vacíos; la paleta requiere al menos dos roles distintos, hex `#RRGGBB`, y cada decisión exige razón. `confirmedServices` puede estar vacío sólo si el llamador confirma explícitamente `noConfirmedServices: true` en una revisión futura del esquema; v1 rechaza vacío. No existen campos para reseñas, precios, horarios, premios, fundadores o años de experiencia: no se generan ni se completan.

Salida `data`:

```ts
{
  project: { slug: string; path: string; packageName: string };
  branch: { name: string; baseSha: string; headSha: string; remoteUrl: string | null };
  commit: { sha: string; message: string };
  files: Array<{ path: string; sha256: string; operation: "CREATE" }>;
  validation: Array<{ name: string; status: ExecutionStatus; command: string; logPath: string }>;
  pullRequest: null; // crear PR no forma parte de esta herramienta v1
}
```

La operación valida antes de escribir, exige checkout limpio y `HEAD === baseSha`, crea una rama nueva, usa el scaffold neutral, escribe sólo datos confirmados y dirección suministrada, marca `nexus.clientProject: true`, valida y hace un commit normal. Cualquier fallo posterior a crear la rama produce `FAIL`, conserva la rama para diagnóstico y enumera exactamente los cambios; nunca publica éxito parcial. Errores: `ART_DIRECTION_REQUIRED`, `INVALID_ART_DIRECTION`, `UNCONFIRMED_BUSINESS_DATA`, `INVALID_SLUG`, `TARGET_EXISTS`, `DIRTY_WORKTREE`, `STALE_BASE_SHA`, `BRANCH_POLICY_DENIED`, `VALIDATION_FAILED`, `COMMIT_FAILED`.

### `nexus_build`

Entrada:

```ts
{
  target: string;       // slug exacto de app CLIENT/REFERENCE/PROBE/SEED
  sourceSha: string;
  clean?: boolean;      // default true
}
```

Salida `data`:

```ts
{
  target: { slug: string; path: string; packageName: string };
  command: string;
  exitCode: number;
  durationMs: number;
  logPath: string;
  manifest: {
    authority: "NEXUS_MCP_BUILD_MANIFEST_V1";
    sourceSha: string;
    target: string;
    nodeVersion: string;
    pnpmVersion: string;
    lockfileSha256: string;
    files: Array<{ path: string; byteLength: number; sha256: string }>;
    manifestSha256: string;
  } | null;
}
```

Sólo `exitCode === 0`, SHA estable, checkout sin cambios inesperados y manifiesto completo permiten `PASS`. En fallo no se emite un manifiesto válido. Errores: `TARGET_NOT_FOUND`, `SOURCE_SHA_MISMATCH`, `DIRTY_WORKTREE`, `DEPENDENCIES_UNAVAILABLE`, `BUILD_TIMEOUT`, `BUILD_FAILED`, `ARTIFACT_ENUMERATION_FAILED`.

### `nexus_gates`

El gate `build` exige `target` y usa exactamente la ruta de `nexus_build`: una construcción, seguida por la generación y validación de `NEXUS_MCP_BUILD_MANIFEST_V1` contra el SHA fuente y los bytes enumerados. No compara dos construcciones.

Entrada:

```ts
{
  target?: string; // ausente = gates de repositorio
  sourceSha: string;
  gates?: Array<"lint" | "typecheck" | "test" | "build" | "quality-gates" | "browser">;
}
```

Salida `data`:

```ts
{
  gates: Array<{
    id: string;
    status: ExecutionStatus;
    command: string;
    exitCode: number | null;
    durationMs: number;
    logPath: string | null;
    reason: string | null;
    evidencePaths: string[];
  }>;
  counts: { pass: number; fail: number; notTested: number };
}
```

Cada gate corre de forma independiente cuando sea seguro hacerlo. La salida normaliza el actual `NOT TESTED` a `NOT_TESTED` en la API. Resultado global: `FAIL` si hay algún `FAIL`; en ausencia de fallos, `NOT_TESTED` si hay alguno; `PASS` sólo si todos pasan. Errores: `UNKNOWN_GATE`, `SOURCE_SHA_MISMATCH`, `GATE_TIMEOUT`, `TOOL_UNAVAILABLE`, `GATE_OUTPUT_INVALID`.

### `nexus_comparator`

Entrada exclusiva por target o URL:

```ts
{
  source: { target: string } | { url: string };
  sourceSha?: string; // obligatorio para target local
  viewports?: Array<{ name: string; width: number; height: number }>;
}
```

Salida `data`:

```ts
{
  source: { kind: "TARGET" | "URL"; value: string; finalUrl: string | null };
  viewports: Array<{
    name: string;
    width: number;
    height: number;
    capturedByType: Record<"landmark" | "heading" | "text" | "interactive" | "media" | "container", number>;
    violations: Array<{
      code: string;
      severity: "ERROR" | "WARNING";
      selector: string | null;
      relatedSelectors: string[];
      bounds: { x: number; y: number; width: number; height: number } | null;
      measured: Record<string, number | string | boolean>;
      threshold: Record<string, number | string | boolean>;
      evidencePath: string;
    }>;
  }>;
  totals: { capturedByType: Record<string, number>; violations: number };
}
```

V1 debe bloquear URL no HTTP(S), credenciales embebidas, localhost, rangos privados/link-local y redirecciones hacia ellos (protección SSRF). No ejecuta login ni acepta cookies del usuario. Violaciones mínimas: overflow horizontal, elementos interactivos solapados/ocultos, texto recortado, objetivos táctiles por debajo de umbral, contenido fuera del viewport y superposición de landmarks. Errores: `EXACTLY_ONE_SOURCE_REQUIRED`, `URL_DENIED`, `TARGET_NOT_FOUND`, `BROWSER_UNAVAILABLE`, `NAVIGATION_FAILED`, `COMPARATOR_TIMEOUT`, `NO_ELEMENTS_CAPTURED`.

**Brecha explícita:** hoy no existe comparator geométrico en el repositorio. El pixel diff de CI no satisface este contrato. Esta herramienta debe permanecer `NOT_TESTED`/no publicarse hasta implementar el comparator y un fixture negativo permanente.

### `nexus_capture`

Entrada:

```ts
{
  source: { target: string } | { url: string };
  sourceSha?: string;
  viewports?: {
    mobile?: { width: number; height: number };   // default documentado en implementación
    desktop?: { width: number; height: number };
  };
  fullPage?: boolean; // default true
}
```

Salida `data`:

```ts
{
  captures: Array<{
    viewport: "mobile" | "desktop";
    width: number;
    height: number;
    browser: string;
    finalUrl: string;
    artifact: { path: string; mediaType: "image/png"; byteLength: number; sha256: string; url: string };
  }>;
}
```

`PASS` exige ambas capturas solicitadas. Una captura móvil exitosa y desktop fallida es `FAIL`, con ambas evidencias enumeradas. Aplica la misma política SSRF del comparator. Errores: `URL_DENIED`, `TARGET_NOT_FOUND`, `BROWSER_UNAVAILABLE`, `TARGET_START_FAILED`, `NAVIGATION_FAILED`, `CAPTURE_FAILED`, `ARTIFACT_STORAGE_FAILED`.

### `nexus_passport`

Entrada:

```ts
{
  target: string;
  sourceSha: string;
  passportPath?: string; // opcional, confinado a directorio de evidencia permitido
}
```

Salida `data`:

```ts
{
  found: boolean;
  path: string | null;
  passport: Record<string, unknown> | null;
  integrity: {
    status: ExecutionStatus;
    algorithm: "sha256";
    declaredHash: string | null;
    computedHash: string | null;
    sourceShaMatches: boolean | null;
  };
  checks: Array<{
    id: string;
    status: ExecutionStatus;
    detail: string;
    evidenceIds: string[];
  }>;
}
```

La herramienta **lee y verifica** un Passport existente; no fabrica uno al consultar. Si no existe devuelve `NOT_TESTED` con `PASSPORT_NOT_FOUND`. Un hash o SHA inválido devuelve `FAIL`. Errores: `TARGET_NOT_FOUND`, `PASSPORT_PATH_DENIED`, `PASSPORT_NOT_FOUND`, `PASSPORT_INVALID_JSON`, `PASSPORT_SCHEMA_INVALID`, `PASSPORT_INTEGRITY_FAILED`, `PASSPORT_SOURCE_MISMATCH`.

## 3. Inventario real: qué existe y qué falta

### `packages/control-sdk`

Existe hoy:

- transporte genérico `command/query`, `RequestMeta` y `NexusControlClient`;
- contratos y plano en memoria para despliegues de flota, permisos, rollout, idempotencia y auditoría;
- telemetría de negocio consentida y agregación;
- tests y build TypeScript de esas capacidades.

No existe allí ninguna de las ocho herramientas MCP, servidor HTTP/MCP, esquemas de entrada/salida, autenticación remota, integración GitHub, acceso git, descubrimiento general de proyectos, runner de comandos, almacenamiento de evidencia ni política SSRF. Reutilizar el transporte genérico no aporta la semántica necesaria; no se debe fingir que el SDK ya es un servidor MCP.

### Capacidades aprovechables fuera del SDK

- `scripts/client-fleet.mjs` ya descubre **clientes explícitos** mediante `nexus.clientProject === true`; sirve como base para la regla de clientes, pero no clasifica toda app en seed/reference/probe/unknown.
- `scripts/scaffold-client.mjs` copia el seed y crea un manifiesto SHA-256; sólo acepta slug. No recibe ni valida negocio/dirección de arte y no crea rama/commit.
- `scripts/quality-gates.mjs` ejecuta arquitectura, typecheck, tests, build y revisiones estáticas con `PASS`/`FAIL`/`NOT TESTED`; su salida es para terminal, no un contrato JSON estable por gate.
- los scripts raíz exponen lint, typecheck, test, build, quality gates y gates adicionales.
- `@nexus/capture` posee contratos de captura y un adaptador Playwright real con screenshots/evidencia; hoy está orientado a una matriz/fixture de pruebas, no a cualquier app seleccionada por una herramienta remota.
- `@nexus/quality` crea y verifica Quality Passports que vinculan SHA, checks y hashes; CI también produce un Passport de navegador con un esquema distinto.
- CI consulta el SHA exacto y publica artefactos. `scripts/ci-browser-quality.mjs` hace comparación de píxeles con ImageMagick y devuelve `NOT_TESTED` sin baseline.
- no existe el comparator **geométrico** solicitado. El propio audit del repositorio lo declara una capacidad faltante.
- `NEXUS_MCP_BUILD_MANIFEST_V1` es el manifiesto de identidad de build ligado al SHA fuente; `nexus_build` y el gate `build` comparten su ruta de construcción y validación.

Antes de implementar habrá que decidir si unificar los dos formatos actuales de Passport o exponerlos como variantes discriminadas. La propuesta v1 acepta ambos mediante adaptadores, preserva el JSON original y reporta qué verificador se aplicó; no reescribe evidencia histórica.

## 4. Ubicación y arquitectura operativa

```text
packages/mcp-server/
  src/server.ts              # protocolo MCP/Streamable HTTP
  src/auth.ts                # autenticación y scopes
  src/contracts/             # schemas cerrados y sobre común
  src/tools/                 # ocho handlers delgados
  src/adapters/git.ts
  src/adapters/github.ts
  src/adapters/process.ts
  src/adapters/artifacts.ts
  src/policy/                # ramas, comandos, paths, URL/SSRF
  tests/
```

No vive en `packages/core`: es control operativo e integración, no una API visual estable. No vive en `runtime`: el plano Rust es independiente y MCP es una entrada no confiable. `packages/control-sdk` puede recibir después contratos de cliente remoto sólo si aparece un consumidor real; v1 evita mezclar sus permisos de flota con permisos del repositorio.

El despliegue necesita: clon privado/autenticado del repo, Node 24, pnpm 10.15.0, git, espacio efímero, Playwright/Chromium y, para el comparador de píxeles existente, ImageMagick. Los artefactos deben ir a almacenamiento privado con URLs firmadas y caducidad; no al filesystem efímero como enlace final.

## 5. Autenticación apta para teléfono

### Recomendación v1

Un solo **token de acceso opaco**, generado una vez (mínimo 256 bits), enviado como `Authorization: Bearer …`, guardado únicamente como variable secreta del proveedor y en el gestor seguro del cliente MCP. Josue sólo copia una URL y un token desde el navegador del teléfono. El servidor guarda sólo el hash del token, compara en tiempo constante, nunca lo imprime y permite rotación desde el panel web.

Scopes separados desde el inicio:

- `nexus:read`: status, projects, passport;
- `nexus:execute`: gates, capture, build, comparator;
- `nexus:write-branch`: project_new.

Para los bloques 1–3 se entrega un token sin `nexus:write-branch`. El token con escritura se crea recién en el bloque 4. GitHub usa por separado una GitHub App de mínimo privilegio (Contents read, Pull requests read, Checks read; Contents write sólo al habilitar `project_new`). Nunca se entrega el token GitHub al asistente.

**Condición de compatibilidad:** antes de desplegar se debe confirmar que el cliente móvil elegido permite un header Bearer estático. Si sólo acepta el flujo de autorización MCP/OAuth, no se improvisa: se sustituye este mecanismo por OAuth 2.1 con PKCE y una pantalla de login web. Eso conserva la operación móvil, pero agrega proveedor/implementación OAuth y costo de desarrollo. Esta es una decisión de arquitectura que requiere aprobación tras identificar el cliente exacto (Claude web, ChatGPT u otro).

Medidas obligatorias: HTTPS, rate limit, body máximo, timeouts, auditoría sin secretos, rechazo por defecto, revocación, separación del token GitHub, y sin secretos en argumentos de comandos, resultados MCP o artefactos.

## 6. Hospedaje remoto accesible por URL

Los precios cambian y deben verificarse en la página del proveedor al contratar. Durante este diseño, el entorno de trabajo no pudo abrir las páginas de precios (proxy devolvió HTTP 403), por lo que las cifras siguientes son **rangos orientativos, no cotizaciones verificadas**.

| Opción | Encaje real | Ventajas desde Android | Desventajas | Costo orientativo |
|---|---|---|---|---|
| **Render, Web Service Docker** | Bueno para bloques 1–3 si la imagen incluye git/pnpm/Chromium/ImageMagick y se añade almacenamiento de objetos. | Alta, dominio HTTPS y variables secretas desde panel web; despliegue desde GitHub. | Plan gratuito, si está disponible, duerme y suele tener disco/CPU insuficiente para builds y browsers; filesystem efímero; minutos de build y RAM pueden obligar a subir plan. | Aproximadamente US$7+/mes para una instancia siempre activa, más almacenamiento/egress; verificar [precios de Render](https://render.com/pricing). |
| **Railway, servicio Docker** | Bueno; Docker y volumen facilitan checkout/cache, aunque los artefactos deben salir a object storage. | Alta, proyecto y secretos manejables desde navegador; despliegue GitHub sencillo. | Cobro por uso y posible gasto variable durante builds/Playwright; hay que fijar límites; el volumen no sustituye aislamiento por ejecución. | Suscripción/consumo desde aproximadamente US$5/mes históricamente, más recursos; verificar [precios de Railway](https://railway.com/pricing). |
| **Fly.io, Machine Docker** | Bueno técnicamente y flexible para worker con volumen; apropiado si se controla Docker. | Media-baja: panel existe, pero varias tareas operativas suelen ser más cómodas con CLI. | Más operación, facturación granular, configuración de volumen/región y riesgo de máquina detenida o gasto variable. | Pago por máquina/volumen/egress; una VM pequeña suele ser de un dígito a decenas de USD/mes según tamaño; verificar [precios de Fly.io](https://fly.io/docs/about/pricing/). |
| **Google Cloud Run + Cloud Build/Jobs + Artifact Storage** | Bueno si el endpoint sólo orquesta jobs aislados; mejor seguridad/escalado para comandos largos que ejecutar todo dentro del servidor HTTP. | Media: consola web completa, pero configuración inicial compleja en teléfono. | Arquitectura más compleja, cold starts, límites/timeouts y varias facturas/identidades; Playwright/build debe correr como Job, no como request largo. | Puede caber en free tier con uso bajo, luego pago por CPU/RAM/build/storage; verificar [precios de Cloud Run](https://cloud.google.com/run/pricing). |
| **Cloudflare Workers solamente** | **No recomendado** para el ejecutor: no ofrece un checkout POSIX general ni puede correr git, pnpm, Next build, Chromium e ImageMagick como este repo exige. Puede servir como proxy/auth delante de otro worker. | Alta para dominio y secretos. | No resuelve la ejecución real; añadir Containers/Browser Rendering cambia arquitectura y sigue requiriendo validar compatibilidad/costos. | Bajo para proxy, pero no comparable como host único; verificar [precios de Workers](https://developers.cloudflare.com/workers/platform/pricing/). |
| **Servidor propio/VPS** | Técnicamente viable con Docker y object storage. | Baja: parches, firewall, backups y recuperación desde teléfono son una carga y un riesgo. | Josue se convierte en operador de sistema; mayor superficie de ataque; no recomendado para v1. | Aproximadamente US$5–20+/mes más almacenamiento y tiempo operativo, según proveedor. |

**Elección propuesta:** Render Docker para el piloto de sólo lectura por simplicidad móvil; Railway como alternativa si Render no soporta de forma fiable los jobs/recursos requeridos. Antes del bloque 2 se hace una prueba real de Chromium y límites de timeout/RAM. Para operación seria, separar API MCP de runners efímeros por job evita que un build bloquee o contamine el servidor.

GitHub Actions por sí solo no es servidor MCP persistente accesible por URL. Puede ser un backend de ejecución disparado por la API en una versión posterior, pero introduce cola, artefactos y permisos de workflow que hay que modelar explícitamente.

## 7. Riesgos y controles

1. **Ejecución remota de comandos.** Nunca aceptar comandos, flags, paths o nombres de paquetes libres. Allowlist fija, `spawn` sin shell, cwd confinado, límites de CPU/memoria/tiempo y kill de todo el process group.
2. **SSRF en URL.** Resolver DNS antes de conectar y en cada redirect; bloquear loopback, privados, link-local, metadata cloud, esquemas no HTTP(S), puertos no permitidos y URLs con credenciales.
3. **Supply chain.** `pnpm install --frozen-lockfile`; no instalar dependencias indicadas por el usuario. Imagen fijada y acciones/dependencias pinneadas.
4. **Escrituras concurrentes o checkout contaminado.** Worktree aislado por request, lock por branch, base SHA obligatorio, limpieza verificada y nunca compartir `.next`/artefactos como evidencia entre SHAs.
5. **Fuga de secretos.** Redacción estructurada de logs, secretos sólo en variables/identity provider, URLs firmadas cortas, no capturar páginas autenticadas y no devolver `.git`, `.env`, headers o configuración del host.
6. **Artefactos falsos o obsoletos.** Hash SHA-256, source SHA, target y timestamps obligatorios; verificar integridad al leer; `NOT_TESTED` ante evidencia ausente.
7. **Costo/DoS.** Rate limit por scope, una operación pesada concurrente en piloto, cuotas diarias, tamaños máximos, cancelación y métricas de consumo.
8. **GitHub token excesivo.** GitHub App de repo único y mínimo privilegio. Escritura deshabilitada hasta bloque 4. Sin permiso de merge, administración, deployments, environments o secrets.
9. **Prompt injection desde repo/página.** El contenido capturado es dato no confiable. Los handlers no interpretan instrucciones halladas en archivos o páginas.
10. **Clasificación errónea.** Sólo `nexus.clientProject === true` prueba cliente. Prefijos únicamente clasifican seed/reference/probe; no promueven a cliente.
11. **Semántica divergente de Passport.** Preservar esquemas y verificadores existentes; no declarar íntegro un Passport que sólo pudo parsearse.
12. **Binarios en git.** Screenshots/builds/logs van a almacenamiento de artefactos y `.gitignore`, jamás al commit de `project_new`.

### No exponer

- contenido de `.env`, tokens, claves, cookies, secretos/environments de GitHub o variables del host;
- acceso arbitrario al filesystem, shell, procesos, red o logs completos sin redacción;
- endpoints internos/metadata cloud o navegación autenticada;
- ramas/repositorios distintos del allowlist;
- acciones de merge, deploy, force-push, delete, releases, tags o cambios en producción;
- APIs de `runtime` que permitan construir/despachar `EdgeTask` o saltar policy/simulation/approval;
- datos de clientes no confirmados ni inferencias de reseñas, precios, horarios, premios, fundadores o experiencia.

## 8. Fuera de alcance de v1

- llamadas a LLM, agentes autónomos o generación estética;
- merge, deploy, rollback de producción, administración de DNS o hosting de sitios;
- creación automática de PR (la herramienta de escritura termina en rama+commit; una PR sería una capacidad separada y aprobada);
- edición general de apps existentes o shell remoto;
- múltiples repositorios/tenants y control empresarial avanzado;
- secretos de sitios, login/cookies para capturar páginas privadas;
- comparator semántico por IA o juicio humano automatizado;
- afirmar certificaciones, equivalencia visual absoluta o calidad humana sólo porque gates pasaron;
- almacenamiento indefinido de artefactos;
- ejecución del plano Rust/V3/V4/V6 mediante MCP;
- OAuth completo si el cliente elegido acepta Bearer; si no lo acepta, OAuth pasa a ser prerequisito, no se omite.

## 9. Secuencia de entrega y puntos de parada

1. Implementar `nexus_status` + `nexus_projects`, tests, despliegue y PR propia. Probar desde el cliente móvil y detenerse.
2. Sólo tras aprobación: `nexus_gates` + `nexus_passport` + `nexus_capture`, tests, despliegue y PR propia. Detenerse.
3. Sólo tras aprobación: `nexus_build` + implementación previa del comparator geométrico + `nexus_comparator`, fixture negativo, tests, despliegue y PR propia. Detenerse.
4. Sólo tras aprobación: `nexus_project_new`, token/scopes de escritura, validación transaccional, tests y PR propia.

Ningún bloque cuenta como implementado hasta tener rama remota real, SHA real, URL real de PR, URLs reales de CI y validación verde. Un fallo de publicación se informa como tal; nunca se inventan enlaces ni estados.

## 10. Decisiones que requieren aprobación antes de Fase 2

1. Cliente MCP móvil exacto que se conectará primero, para confirmar Bearer estático frente a OAuth 2.1/PKCE.
2. Proveedor piloto: Render (recomendado por simplicidad) o Railway.
3. Política de URL para `capture/comparator`: sólo targets locales en v1 (más seguro) o URLs públicas con la política SSRF descrita.
4. `project_new`: confirmar que termina en rama+commit sin crear/pushear PR automáticamente.
5. Formato de Passport: aceptar las dos variantes actuales mediante adaptadores (recomendado) o exigir migración/unificación previa.
