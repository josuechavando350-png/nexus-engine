# Bot MD — 0.2.1

Bot MD extrae el contenido renderizado de páginas web a Markdown, captura sus recursos, reconstruye una copia local y compara el resultado con las observaciones originales. Antes se llamaba Nexus Replica.

**Sí genera `.md`. No existe en esta versión una garantía de copiar cualquier web al 100 %.** El Markdown conserva principalmente contenido y estructura textual. La reconstrucción visual utiliza además HTML, CSS, JavaScript, fuentes, recursos y estados capturados. No recupera el backend ni el repositorio privado del sitio.

## Instalación

Desde la raíz de Nexus Engine:

```bash
cd tools/bot-md
npm ci
npm run browsers
```

Requisitos: Node.js 22 o superior y Chromium compatible con Playwright. La captura y su verificación deben usar la misma versión del navegador. Para usar un Chromium instalado: `CHROMIUM_EXECUTABLE_PATH=/ruta/chromium`.

## Sacar Markdown de una URL

```bash
npm run bot-md -- capture --url https://example.com/ --max-pages 1 --out runs/captura
```

Los archivos quedan en `runs/captura/states/<estado>/content.md`. Un estado representa una página, un tamaño de pantalla y, cuando se configura, una interacción. Puede haber varios Markdown de una misma página. `manifest.json` relaciona estados, URLs, recursos y observaciones.

## Reconstruir y verificar

```bash
npm run bot-md -- run --url https://example.com/ --max-pages 1 --out runs/sitio
npm run bot-md -- serve --site runs/sitio/site --port 4173
```

Abrir http://127.0.0.1:4173/. El resultado de `run` incluye Markdown en `capture/states/`, código conservado en `site/` e informe en `verification/`. Cada ejecución necesita una carpeta de salida nueva.

La copia conserva y adapta el frontend entregado al navegador; no genera automáticamente componentes React nuevos. El servidor de previsualización escucha en loopback y reproduce las respuestas GET registradas. Las solicitudes no capturadas fallan y se registran.

## Prueba de Daksh

```bash
npm run bot-md -- run --config validation/daksh/full-config.json --out runs/daksh
```

La prueba documentada cubrió siete páginas, tres tamaños y 47 estados. En el barrido completo aprobaron 45; los otros dos aprobaron en una repetición explícita. Se conservaron ambos resultados. Hubo 88 URLs de recursos tras completar dependencias CSS.

- [Informe de validación](docs/DAKSH_VALIDACION.md)
- [Resultado por estado](evidence/daksh/assessment.json)
- [Estado de incorporación a Nexus Engine](docs/GITHUB_STATUS.md)

Esta carpeta contiene el motor, las pruebas, configuraciones y evidencia numérica. Los Markdown y recursos de terceros se generan localmente al ejecutar la captura. La copia preconstruida y sus 47 Markdown fueron entregados en el paquete histórico; no están incluidos en esta carpeta del repositorio.

## Comandos adicionales

```bash
npm run bot-md -- build --capture runs/captura --out runs/copia
npm run bot-md -- verify --capture runs/captura --site runs/copia --out runs/informe
npm run bot-md -- enrich --capture runs/captura --out runs/completada
npm run bot-md -- repair --capture runs/captura --site runs/copia --out runs/reparacion
```

`enrich` obtiene dependencias CSS y respuestas RSC como bytes HTTP en otra carpeta, conservando la procedencia y las observaciones originales. `repair` propone cambios CSS respaldados por las mediciones, verifica su efecto y revierte los que empeoran el resultado.

Se admiten escenarios JSON con clic, hover, foco, selección, escritura, teclado y scroll; ver `examples/config.json`. La exploración automática es limitada. `readySelector` y `readySelectors` permiten esperar señales reales de preparación del sitio. No se rellenan datos faltantes con contenido inventado.

Para verificar estados específicos: `verify --states p0-mobile-s5,p2-tablet-s1`. El resultado declara que es parcial. `REPLICA_VERIFY_WORKERS` permite entre uno y cuatro estados concurrentes, dos por defecto. Las variables `REPLICA_*` y el comando `npm run replica` se mantienen por compatibilidad.

## Red y entorno

Un proxy se configura explícitamente con `REPLICA_PROXY_URL` y `REPLICA_PROXY_HOSTS` (hosts exactos separados por comas). La verificación local no utiliza ese proxy. Para una CA de confianza propia: `REPLICA_CA_CERT` configura Chromium y `NODE_EXTRA_CA_CERTS` configura las peticiones HTTP de Node. Las redes privadas se rechazan salvo `--allow-localhost` para pruebas locales.

Las nuevas capturas registran hover/pointer/movimiento reducido y mantienen la sesión de inspección CDP hasta cerrar el contexto. `verify --legacy-cdp-replay` es exclusivamente para reproducir las condiciones de capturas históricas afectadas por la desconexión CDP; el informe declara su uso. No es necesario para capturas nuevas.

## Validación y límites

```bash
npm run typecheck
npm run format:check
npm test
npm run demo
```

Las pruebas de integración y la demo necesitan Chromium. La demo usa un sitio de prueba propio y verifica la copia con el origen apagado.

Un estado aprobado exige integridad, dimensiones compatibles, diferencia visual dentro del umbral, geometría/texto coherentes, aserciones aprobadas y ausencia de errores de red/JavaScript observados. Los umbrales predeterminados son `pixelThreshold=0.1`, `maxDiffRatio=0.005` y `geometryTolerance=1` píxel CSS; se excluye antialiasing. Ninguna región se enmascara.

La validación cubre los estados medidos en Chromium. No certifica todos los estados posibles, Safari/Firefox, animación temporal completa, autenticación, formularios reales, WebSockets, lógica del servidor ni datos futuros. Se solicita movimiento reducido para las capturas.

[Arquitectura y límites operativos](docs/ARQUITECTURA.md).
