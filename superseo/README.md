# SUPERSEO · NEXUS DOMINIO

SUPERSEO es el Súper SEO de Nexus Bot Studio: un solo punto de entrada que rastrea el sitio de un cliente, lo audita, corre los SEO Avengers sobre lo que encontró, arma una estrategia propia para ese cliente y se prende o se apaga por cliente.

Se activa por cliente. Si un cliente no tiene SUPERSEO, su sitio queda como sitio NEXUS normal.

## Qué hay adentro

| Rol | Pieza | Estado |
| --- | --- | --- |
| Ojos | NEXUS Crawler, Despertador de autoridad | Conectados |
| Cerebro | Estratega, Territorios, Interruptor, SEO Avengers M1001–M2500 | Conectados |
| Manos | Candado anti-clones | Conectado |
| Cerebro | Avengers M001–M1000, WALLE, GAUSS, AXIOMA, FORJA y paquetes de SEO | Disponibles, por conectar |
| Manos, tercer ojo, arma | Forja de páginas, indexación, oráculo, vigía, Observatorio, panel | Por construir |

El detalle exacto, con rutas, vive en [`manifiesto.json`](manifiesto.json) y una prueba impide que declare algo que no existe.

Los SEO Avengers se quedan en sus carpetas (`seo-avengers-*`): sus verificadores, sus workflows y la cadena de WALLE dependen de esas rutas. SUPERSEO los llama desde [`cerebro/avengers.mjs`](cerebro/avengers.mjs); no hay que moverlos para usarlos.

```
superseo/
  cli.mjs              comandos
  reporte.mjs          reporte en español
  manifiesto.json      todo lo que forma SUPERSEO y su estado
  clientes/            un perfil JSON por cliente (registro central)
  core/                perfil, catálogo, estratega, territorios, interruptor, anti-clones
  ojos/                crawler y auditoría técnica
  cerebro/             puente a los SEO Avengers
  tests/               pruebas (node --test)
```

## Comandos

Desde la raíz del repositorio:

```sh
node superseo/cli.mjs estado                      # clientes, estado, plan y potencia
node superseo/cli.mjs estrategia cano             # estrategia completa en JSON
node superseo/cli.mjs territorios                 # choques entre clientes
node superseo/cli.mjs preparar cano               # construye y mide, no publica
node superseo/cli.mjs encender cano "pagó"        # publica y corre el ciclo
node superseo/cli.mjs apagar cano "no pagó"       # sitio normal; páginas redirigen
node superseo/cli.mjs plan cano TOTAL
node superseo/cli.mjs insumo cano search_console si
node superseo/cli.mjs insumo cano revisor cliente
node superseo/cli.mjs ciclo cano --max 300        # rastreo + auditoría + Avengers + reporte
```

Desde el teléfono: en GitHub, Actions → **SUPERSEO** → Run workflow, elige el cliente. El reporte aparece en el resumen de la ejecución y se descarga como artefacto. También corre solo cada lunes.

## Cómo se activa en un cliente nuevo

1. Copia `clientes/cano.json` como `clientes/<id>.json` y llena sus datos: dominio, rubro, servicios con su ruta, marca, contacto y territorio (especialidades y zonas).
2. `node superseo/cli.mjs preparar <id>`. Si su territorio choca con un cliente exclusivo, SUPERSEO no lo deja pasar.
3. Marca lo que vaya entregando con `insumo`. Nada de eso bloquea: cada insumo cambia la estrategia y sube la potencia.
4. `node superseo/cli.mjs encender <id>` cuando arranque la mensualidad.

## Reglas que no se negocian

- **Nada de trucos.** Todo es white-hat: sin páginas clonadas, sin reseñas falsas, sin enlaces comprados, sin scrapear Google. Los Avengers corren en modo observación.
- **Contenido sensible con revisor.** En abogados y salud, el contenido legal o médico espera en borrador hasta que lo revise el cliente o Nexus. Lo técnico avanza sin esperar.
- **Territorios respetados.** Un cliente con exclusividad bloquea a otro en su especialidad y zona; uno compartido genera un aviso que debe estar en ambos contratos.
- **Apagar no rompe nada.** Las páginas de SUPERSEO redirigen con 301 a su servicio; el sitio base sigue igual.
- **Metas, no garantías.** Ningún reporte promete posiciones en Google.

## Pruebas

```sh
node --test superseo/tests/*.test.mjs
```

Incluyen la ejecución real de los 1,500 módulos de Avengers (necesita `python3`), el rastreo de un sitio falso con errores típicos y la validación de que el manifiesto no promete nada que no exista.
