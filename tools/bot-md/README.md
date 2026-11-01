# Bot MD — 0.6.0

Bot MD captura la apariencia y el comportamiento observado de una web para reconstruir una versión local con contenido editable. Conserva HTML, CSS, JavaScript, fuentes y recursos; además genera documentación Markdown de estilos y movimiento.

La versión 0.3.0 añadió **ESTILOS.md**, **MOVIMIENTO.md**, un catálogo de contenido, sustitución de textos sin destruir elementos anidados, trazas SVG durante el scroll y detección de diferencias. El Markdown documenta la experiencia; el código y los recursos la ejecutan.

La reconstrucción conserva el frontend que recibe el navegador. No genera automáticamente componentes fuente nuevos. La aprobación corresponde a tamaños, estados y muestras medidos; no equivale a copiar cualquier web al 100 %.

## Novedades 0.6.0

`materialize` admite `svgPaths`: geometrías propias que sustituyen trazos declarados en HTML, JavaScript y datos JSON/Flight. La sustitución permanece al hidratar y recargar. Las reglas registran coincidencias por formato y una geometría inválida o una regla sin coincidencias impide declarar la operación aprobada.

La demostración de Daksh amplía el plan a 140 reglas de texto y 11 trazos de dos firmas. Incluye textos provisionales identificados como demostración, sin atribuir proyectos o resultados del autor a Nexus. El catálogo mantiene visibles los campos sin revisar. [Uso, evidencia y pendientes de 0.6.0](docs/GRAFICOS_Y_COBERTURA.md).

## Novedades 0.5.0

El nuevo comando `materialize` aplica cambios antes de servir HTML, JavaScript, JSON y datos de navegación React Flight. El contenido declarado permanece sustituido al hidratar, navegar y recargar; no depende de modificar el DOM después de cargar. Conserva los recursos de estilo y registra cada sustitución. Las tramas no soportadas detienen la exportación. El ajuste opcional de títulos comprueba recortes de texto y `complete-requests` obtiene variantes RSC GET faltantes desde el origen, conservando sus parámetros.

```bash
npm run bot-md -- materialize --site runs/copia --replacements sustituciones.json --out runs/compilada
```

[Uso, formato del plan y límites](docs/CONTENIDO_COMPILADO.md). La eliminación completa del contenido de la referencia y la integración global de Nexus siguen pendientes.

## Novedades 0.4.0

El perfil de reloj controlado espera una señal explícita de preparación y avanza temporizadores/requestAnimationFrame en pasos medidos. El flujo `run` repite el origen antes de comparar, para detectar una referencia inestable. No controla animaciones CSS del compositor, vídeo ni todos los subsistemas del navegador.

En Daksh, la comparación controlada aprobó 48 muestras del hilo SVG en escritorio/móvil, y también aprobó la repetición del origen. Diferencia máxima de puntos: 0,031 px; tolerancia: 2 px, sin ampliarla. Esto valida las muestras y condiciones declaradas, no cada frame posible ni toda la web.

El catálogo ahora incluye enlaces, medios y metadatos de contenido. Corrige la asignación de ruta cuando una interacción termina en otra página. La plantilla admite archivos propios con `--assets`; `audit-content` identifica campos pendientes y restos de información en los archivos realmente servidos.

[Resultados y pendientes de 0.4.0](docs/CONTROL_Y_CONTENIDO.md).

## Estilos, movimiento y contenido editable

```bash
npm run bot-md -- styles --capture runs/captura --out runs/estilos
npm run bot-md -- catalog --capture runs/captura --out runs/contenido
# Editar los valores en runs/contenido/content.json.
npm run bot-md -- template --site runs/copia --content runs/contenido/content.json --out runs/plantilla
npm run bot-md -- serve --site runs/plantilla
```

`styles` exporta colores, tipografía, medidas observadas, variables CSS, condiciones responsive, reglas de fuentes y keyframes; también conserva las hojas CSS capturadas. Los valores computados provienen de los estados de la captura, sin inventar roles como «color principal» por su frecuencia.

`catalog` descubre nodos de texto y etiquetas accesibles en todos los estados. `template` sustituye campos declarados después de la preparación de la página, conserva los elementos y notifica cambios de tamaño. Los conflictos se exponen en `window.__BOT_MD_CONTENT__`. La sustitución visible no elimina la información incrustada en imágenes, JavaScript o respuestas conservadas: revisar y reemplazar todos esos elementos sigue siendo necesario para una publicación con contenido propio.

```bash
npm run bot-md -- motion --url https://dakshgajjar.com/ --config validation/daksh/controlled-motion-config.json --out runs/movimiento-origen
npm run bot-md -- enrich --capture runs/captura --trace runs/movimiento-origen --out runs/captura-ampliada
npm run bot-md -- build --capture runs/captura-ampliada --out runs/copia-ampliada
npm run bot-md -- motion --site runs/copia-ampliada --config validation/daksh/controlled-motion-config.json --out runs/movimiento-local
npm run bot-md -- compare-motion --reference runs/movimiento-origen --candidate runs/movimiento-local --out runs/comparacion
```

`motion` mantiene las animaciones activas, mide puntos/longitud/progreso SVG durante scroll de ida y regreso y registra las condiciones de entrada. El perfil móvil usa entrada táctil. Las rutas vacías se conservan como geometría de longitud cero. `enrich --trace` obtiene variantes GET observadas durante el movimiento, conservando sus parámetros y cabeceras de enrutamiento.

Para medir la variación del propio origen, genera una segunda traza remota con el mismo perfil y añade `--repeat-reference RUTA` a `compare-motion`. Una referencia completa, sin incidencias, que cambia produce `unstable`; una referencia incompleta o con errores falla. no se amplían umbrales para forzar una aprobación. Las comparaciones exigen el mismo navegador y perfil. Las trazas se sellan con SHA-256.

- [Prueba de movimiento y contenido en Daksh](docs/EXPERIENCIA.md)
- [Configuración de textos de ejemplo](validation/daksh/editable-content.json)

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

Abrir http://127.0.0.1:4173/. El resultado de `run` incluye Markdown en `capture/states/`, documentación visual en `styles/`, catálogo editable en `content/`, código conservado en `site/` e informe en `verification/`. Cada ejecución necesita una carpeta de salida nueva.

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

Para ejecutar el flujo completo con movimiento y la plantilla de ejemplo:

```bash
npm run bot-md -- run --config validation/daksh/full-config.json --motion-config validation/daksh/controlled-motion-config.json --content validation/daksh/branding-content.json --assets validation/daksh/media --policy validation/daksh/content-audit-policy.json --out runs/daksh-completo
```

Un código de salida 2 significa que alguna validación no aprobó; los resultados y la plantilla permanecen disponibles para inspección. Cambiar contenido requiere comprobar su adaptación, no exigir píxeles iguales a textos distintos.

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

La validación cubre los estados medidos en Chromium. No certifica todos los estados posibles, Safari/Firefox, animación temporal completa, autenticación, formularios reales, WebSockets, lógica del servidor ni datos futuros. Las capturas visuales estáticas solicitan movimiento reducido; el comando `motion` usa movimiento normal y no reemplaza esas pruebas.

[Arquitectura y límites operativos](docs/ARQUITECTURA.md).

## Revisar la sustitución de contenido

```bash
npm run bot-md -- template --site runs/copia --content content.json --assets mis-medios --out runs/plantilla
npm run bot-md -- audit-content --capture runs/captura --site runs/plantilla --content content.json --policy validation/daksh/content-audit-policy.json --out runs/auditoria
```

Usa la captura exacta de la que se construyó el sitio (si se amplió, `capture-completed`). Los medios se registran bajo `/__botmd/media/NOMBRE`; `media-manifest.json` contiene las rutas. El mapa valida `src`, `srcset`, `poster`, enlaces y metadatos permitidos. Los SVG aportados deben ser estáticos, sin acciones ni referencias externas. Los medios no registrados producen error.

La auditoría escribe `SUSTITUCION.md` y `audit.json`. Busca términos declarados en HTML, JavaScript, respuestas y mapas servidos, y enumera contenido y recursos pendientes. No aplica OCR ni promete detectar toda información semántica. Una revisión por hash no silencia términos prohibidos. Tanto `blocked` como `review-required` devuelven código 2; no existe una aprobación automática de eliminación total.

Los cambios de metadatos de la plantilla actual ocurren en el DOM del navegador. El HTML inicial y las respuestas del framework pueden conservar datos anteriores; la auditoría los detecta cuando coinciden con las reglas. La publicación y las tarjetas sociales para rastreadores sin JavaScript requieren reconstruir esos datos iniciales.
