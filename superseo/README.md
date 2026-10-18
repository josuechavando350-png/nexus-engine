# SUPERSEO · NEXUS DOMINIO

SUPERSEO es el Súper SEO de Nexus Bot Studio. Se activa por cliente y hace todo el ciclo:

1. ve el sitio y el mercado;
2. decide qué páginas construir;
3. las escribe con el conocimiento del cliente;
4. las revisa con candados de calidad;
5. las publica según el interruptor;
6. avisa a los buscadores;
7. vigila a la competencia y las noticias del rubro.

Si un cliente no tiene SUPERSEO, su sitio queda como sitio NEXUS normal.

## Qué hay adentro

| Rol | Pieza | Archivo |
| --- | --- | --- |
| Ojos | NEXUS Crawler | `ojos/crawler.mjs` |
| Ojos | Despertador de autoridad (auditoría técnica) | `ojos/auditoria.mjs` |
| Ojos | Search Console (cuenta de servicio) | `ojos/search-console.mjs` |
| Ojos | Demand Miner (+ Keyword Planner y portafolio curado) | `ojos/demanda.mjs` |
| Ojos | Link Graph interno | `ojos/grafo.mjs` |
| Cerebro | Estratega, Territorios, Interruptor | `core/` |
| Cerebro | SEO Avengers M1001–M2500 | `cerebro/avengers.mjs` → `seo-avengers-2500/` |
| Cerebro | GAUSS: lote óptimo de páginas | `cerebro/priorizar.mjs` → `gauss/` |
| Manos | Forja de páginas Torre y redactores | `manos/forja.mjs`, `manos/redactores.mjs` |
| Manos | Candado anti-clones | `core/similitud.mjs` |
| Manos | Publicación en el sitio (app del repo o ZIP) | `manos/publicar.mjs` → `apps/cano-penal/src/app/[superseo]` o `clientes/<id>/entrega/` |
| Manos | Indexación: sitemap, enlaces internos, IndexNow | `manos/indexacion.mjs` |
| Tercer ojo | Vigía de competencia | `tercer-ojo/vigia.mjs` |
| Tercer ojo | Oráculo de tendencias | `tercer-ojo/oraculo.mjs` |
| Arma | Observatorio del delito (datos abiertos FGJ CDMX) | `arma/observatorio.mjs` |
| Control | Panel desde el teléfono | `.github/workflows/superseo-panel.yml` |

El estado exacto de cada pieza (conectada, disponible o por construir) vive en [`manifiesto.json`](manifiesto.json). Una prueba impide que declare algo que no existe.

Los SEO Avengers se quedan en sus carpetas (`seo-avengers-*`), porque sus verificadores y la cadena de WALLE dependen de esas rutas. SUPERSEO los llama desde ahí.

## Operarlo desde el teléfono

Todo se hace en GitHub → **Actions**:

| Workflow | Para qué |
| --- | --- |
| **SUPERSEO** → Run workflow | Ciclo completo: rastreo, auditoría, grafo, Search Console, Avengers, demanda, vigía y oráculo. El reporte sale en el resumen. Corre solo cada lunes. |
| **SUPERSEO Forja** | Forja el siguiente lote de páginas elegido por GAUSS y abre un PR con los borradores. |
| **SUPERSEO Panel** | Encender, preparar, apagar, cambiar plan, marcar insumos, aprobar páginas y publicar. Guarda en main y el sitio lo aplica al desplegar. |
| **SUPERSEO Observatorio** | Actualiza cada mes los datos de la Fiscalía CDMX. |

### El flujo de una página

1. **SUPERSEO Forja** escribe las páginas y abre un PR.
2. Revisas el PR. El cliente revisa el texto legal y tú haces merge.
3. **SUPERSEO Panel** → `aprobar`, con el id de la página, el revisor y quién aprueba.
4. **SUPERSEO Panel** → `encender`, una sola vez por cliente.
5. El sitio publica las páginas aprobadas, las agrega al sitemap y avisa por IndexNow.

Si después cambias una coma de una página aprobada, la aprobación deja de valer y la página no se publica hasta volver a aprobarla.

### Lo que hay que configurar una vez

En Settings → Secrets and variables → Actions:

- **`ANTHROPIC_API_KEY`** (secreto): para que la Forja redacte. Sin él, la Forja acepta contenido escrito a mano (`--redactor manual`).
- **`GSC_SERVICE_ACCOUNT_JSON`** (secreto): la llave JSON de una cuenta de servicio de Google Cloud con la API de Search Console activa. El cliente agrega el correo de esa cuenta como usuario de su propiedad en Search Console.
- **`GSC_PROPIEDAD`** (variable, opcional): por defecto `sc-domain:<dominio>`; usa `https://dominio/` si la propiedad es de prefijo de URL.
- **`SUPERSEO_MODELO`** (variable, opcional): modelo de Claude para la Forja. Por defecto `claude-opus-5-5`.

En Settings → Actions → General, activa **Allow GitHub Actions to create and approve pull requests**, para que la Forja pueda abrir su PR. Si main tiene protección de rama, el Panel y el Observatorio necesitan permiso para hacer push o hay que cambiarlos para que abran un PR.

## Comandos (en una computadora)

```sh
node superseo/cli.mjs ayuda
node superseo/cli.mjs estado
node superseo/cli.mjs ciclo cano --max 300
node superseo/cli.mjs lote cano --volumenes keyword-planner.csv
node superseo/cli.mjs forjar cano --n 5 --snapshot superseo-salida/cano/rastreo.json
node superseo/cli.mjs aprobar cano acusacion-falsa-cdmx --revisor CLIENTE --por "Eduardo Cano"
node superseo/cli.mjs encender cano "arranca la mensualidad"
node superseo/cli.mjs publicar cano
node superseo/cli.mjs forjar nexus --redactor manual --archivo lote.json
node superseo/cli.mjs publicar nexus
```

## Cómo se activa en un cliente nuevo

1. Copia `clientes/cano.json` como `clientes/<id>.json` y llena sus datos: dominio, rubro, servicios con su ruta, marca, contacto y territorio.
2. Crea `clientes/<id>/conocimiento/` con lo que el cliente sabe y aprobó: textos de su sitio y notas de voz transcritas. La Forja solo escribe hechos que estén ahí.
3. Crea `clientes/<id>/sitio.json` con la app del repo y una llave de IndexNow, y publica esa llave en `public/<llave>.txt` del sitio.
4. Agrega en la app la ruta `[superseo]` y el lector `src/superseo/paquete.ts`, igual que en `apps/cano-penal`.
5. **SUPERSEO Panel** → `preparar`. Si su territorio choca con un cliente exclusivo, no pasa.

## Agencias y sitios fuera del repo (Nexus)

Nexus Bot Studio usa SUPERSEO en su propio sitio, que vive fuera del monorepo y se despliega desde un ZIP.

- **Rubro `agencia_web`.** No es sensible (sus páginas aprobadas por los candados se publican sin esperar) y no genera Torres por zona: un texto de agencia repetido por alcaldía sería un clon.
- **Portafolio curado.** `clientes/<id>/portafolio.json` (`schema_version: 1`, `paginas[]`) declara cada página: `id`, `tipo` (GIRO, AGENTE_IA, ADS_MAPS, GUIA, CIUDAD), `grupo`, `titulo`, `intencion`, `consultas`, `servicio` y los `enlaces` internos que debe llevar. Se valida fail-closed: ids repetidos, tipos inventados, enlaces a sí misma o sin grupo no pasan.
- **Entrega por ZIP.** `clientes/<id>/sitio.json` con `"app": null`, `"entrega": "ZIP"` y `rutas` (las páginas fijas del sitio, para validar enlaces sin rastrearlo). `publicar` escribe `clientes/<id>/entrega/paginas.json`; ese archivo se copia a `src/superseo/paginas.json` del sitio, y la llave de IndexNow a `public/<llave>.txt`.
- **Redacción por lotes.** `forjar --redactor manual --archivo lote.json` acepta `{ "paginas": { "<id>": contenido } }` y pasa cada página por los mismos candados.
- **El grupo viaja al sitio.** Cada página publicada lleva su `grupo`, para armar los índices `/industrias` y `/guias`.

## Reglas que no se negocian

- **Nada de trucos.** Todo es white-hat: sin páginas clonadas, sin reseñas falsas, sin enlaces comprados, sin scrapear Google. Los Avengers corren en modo observación.
- **Hechos con fuente.** La Forja rechaza cifras que no estén en el conocimiento del cliente o en los datos verificados, y rechaza promesas como "garantizado" o "100%".
- **Contenido sensible con revisor.** En abogados y salud, el contenido legal o médico espera en borrador hasta que lo revise el cliente o Nexus. Lo técnico avanza sin esperar.
- **Torres con datos reales.** Una página por alcaldía solo pasa si trae al menos 3 datos locales verificados. Sin eso sería un clon con otro nombre de zona.
- **Territorios respetados.** Un cliente con exclusividad bloquea a otro en su especialidad y zona.
- **Apagar no rompe nada.** Las páginas ya aprobadas redirigen a su servicio; el sitio base sigue igual.
- **Metas, no garantías.** Ningún reporte ni página promete posiciones en Google; frases como "primer lugar en Google" se rechazan.

## Pruebas

```sh
node --test superseo/tests/*.test.mjs
```

Incluyen la ejecución real de los 1,500 módulos de Avengers (necesita `python3`), la mochila de GAUSS contra un oráculo exhaustivo, los candados de la Forja, el interruptor de publicación, la firma de Search Console, el Observatorio sobre datos sintéticos y la verificación de que el manifiesto no promete nada que no exista.
