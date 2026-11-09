# NEXUS Web Experience Kit

Biblioteca optativa de cuatro repositorios upstream. Incorporada para reutilizar sus fuentes, documentación y ejemplos en futuras experiencias de NEXUS, sin cargar todas sus dependencias en cada cliente.

## Estado real

- Cuatro fuentes fijadas por commit completo mediante submódulos Git.
- Catálogo con procedencia, función, requisitos y evidencia de licencia.
- Gestor para listar, descargar explícitamente y verificar fuentes.
- Pruebas del gestor; no certificación visual, de rendimiento ni de los proyectos upstream.
- **Ninguna web, componente, bundle, dependencia npm ni despliegue se activa con este cambio.** No equivale a cuatro integraciones de producción terminadas.

Los proyectos conservan su autoría y sus licencias. NEXUS incorpora acceso reproducible a ellos; no adquiere exclusividad ni autoría sobre su código.

## Los cuatro recursos

| ID | Fuente | Función | Modalidad |
| --- | --- | --- | --- |
| `r3f-scroll-rig` | `14islands/r3f-scroll-rig` | Sincronizar DOM, scroll y escenas WebGL. | Biblioteca React; activación solo cliente y fallback DOM. |
| `seam-transitions` | `codrops/SeamTransitions` | Once experimentos de transición entre hero y contenido. | Demos experimentales; no paquete npm ni once componentes listos. |
| `photoswipe` | `dimsemenov/PhotoSwipe` | Galerías ampliables y navegación fotográfica táctil. | Biblioteca independiente del framework. |
| `embla-carousel` | `davidjerleke/embla-carousel` | Carruseles y recorridos de proyectos. | Biblioteca independiente del framework. |

Se incorporan los cuatro primeros recursos marcados como prioridad «Muy alta» en la selección del usuario. Astro no está incluido en este alcance.

## Consultar y recuperar las fuentes

Desde la raíz de NEXUS ENGINE, con Git y Node instalados (el monorepo usa Node 24):

```sh
# Consulta local: sin red, instalación ni ejecución de código upstream.
node scripts/web-experience.mjs list

# Compara catálogo, .gitmodules y gitlinks. Permite fuentes aún no descargadas.
node scripts/web-experience.mjs verify

# Descarga explícita de un único repositorio al commit fijado.
node scripts/web-experience.mjs init photoswipe

# O descarga los cuatro.
node scripts/web-experience.mjs init all

# Exige checkouts presentes, limpios, con commit y archivo de licencia verificados.
node scripts/web-experience.mjs verify all --checkout
```

La descarga necesita acceso a GitHub. El gestor no ejecuta scripts upstream, no instala paquetes npm y no hace `git submodule update --remote`, `--force` ni actualizaciones recursivas. Rechaza cambios locales en las fuentes antes de actualizarlas. No sobrescribir esos cambios: conservarlos primero en un commit o una copia propia.

Los submódulos son referencias Git versionadas, no copias de todos los archivos dentro del repositorio principal. Un clon normal no descarga su contenido; `init` lo recupera. Un ZIP del repositorio principal tampoco incluye las fuentes upstream.

## Activación en una experiencia concreta

Las dependencias de ejecución pertenecen a la aplicación consumidora, no a `packages/core`, `packages/experience` ni `runtime/`. Seleccionar solo lo que el proyecto necesita. Las candidatas a adaptadores reutilizables pertenecen inicialmente a `packages/experimental`.

Ejemplos de instalación **manual y optativa**; sustituir `NOMBRE_DEL_APP` por un paquete real del workspace:

```sh
pnpm --filter NOMBRE_DEL_APP add --save-exact photoswipe
pnpm --filter NOMBRE_DEL_APP add --save-exact embla-carousel
```

`--save-exact` fija la versión publicada que resuelva el registro en ese momento; guardar también el lockfile resultante. Esa versión npm no debe confundirse con el snapshot Git del catálogo. No se ha ejecutado ninguna de estas instalaciones en este cambio.

### PhotoSwipe

Comenzar por el README y `docs/getting-started.md` del snapshot. Instalar su CSS en la aplicación; conservar enlaces a las imágenes como fallback. Proporcionar ancho y alto reales, texto alternativo y foco visible. Inicializar el lightbox después del montaje, cargar su núcleo bajo demanda y llamar a `destroy()` al desmontar. Verificar teclado, cierre y restitución del foco antes de publicar.

### Embla Carousel

Comenzar por el README y los ejemplos del snapshot. La aplicación controla estilos, controles, etiquetas y contenido. No activar autoplay por defecto. Usar el wrapper compatible con el framework o inicializar la biblioteca sobre un elemento existente; destruir la instancia al desmontar. Verificar navegación por teclado y gestos sin impedir el scroll normal de la página.

### Scroll Rig

Revisar `package.json`, el README y `docs/api.md` del snapshot. Resolver React, React DOM, Fiber y Three como un conjunto compatible; comprobar también los peers de Drei para las APIs elegidas. No forzar incompatibilidades con `--force`.

Montar WebGL solo en cliente y bajo demanda. Mantener contenido HTML útil sin WebGL, atender `prefers-reduced-motion` y medir coste GPU y memoria en teléfono. No combinar gestores de scroll globales sin diseñar su coordinación. El paquete no está importado ni instalado en NEXUS con este cambio.

### SeamTransitions

Consultar el README upstream y elegir un único efecto antes de adaptarlo. Para explorar los ejemplos después de `init seam-transitions`:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory vendor/web-experience/seam-transitions
```

Abrir `http://127.0.0.1:4173/` en el navegador. El servidor es local; las demos upstream pueden cargar scripts, fuentes y otros recursos externos. Revisarlos antes de abrirlas en un entorno restringido. No incrustar los HTML completos en producción: separar el efecto, localizar dependencias, retirar código no necesario y añadir cleanup, fallback y movimiento reducido. No copiar identidad visual, textos, fotografías ni fuentes del demo a Core.

## Licencias y procedencia

`catalog.json` registra commit, repositorio y SHA Git del archivo `LICENSE`. Las licencias originales permanecen dentro de cada submódulo. Conservar los avisos aplicables en cualquier código redistribuido.

En el commit fijado de Scroll Rig, **`LICENSE` declara MIT pero `package.json` declara ISC**. La discrepancia se conserva explícitamente en el catálogo; no se ha resuelto ni se declara una autorización comercial global. Revisar la licencia del artefacto que se vaya a distribuir. SeamTransitions tiene su propia licencia MIT; esto no reemplaza las condiciones de GSAP, plugins, fuentes u otros recursos que emplee.

## Contrato para futuras IAs y colaboradores

No importar demos ni dependencias visuales desde Core o Experience Engine. No modificar Rust, NQC, identidades de clientes, despliegues o credenciales para utilizar este kit. No afirmar que una fuente registrada constituye una integración de producción probada.

Al actualizar una fuente, revisar cambios upstream, actualizar juntos el gitlink, el commit del catálogo y el SHA de licencia, y repetir las pruebas. No seguir una rama flotante automáticamente. El catálogo es la fuente de verdad del kit; el lockfile de la aplicación es la fuente de verdad de sus paquetes publicados.

Antes de promover un adaptador: pruebas de lifecycle y SSR, navegación con teclado, movimiento reducido, comportamiento táctil, fallback sin WebGL, presupuesto de carga y ensayo en dispositivos reales. Después ejecutar las validaciones completas del monorepo y comprobar CI.

## Validación reproducible

```sh
node --test tests/web-experience.contract.mjs
pnpm exec vitest run tests/web-experience.test.ts
```

La suite Vitest del repositorio ejecuta también las pruebas offline mediante `tests/web-experience.test.ts`. Los snapshots upstream se excluyen únicamente del ESLint de NEXUS; conservan sus propias herramientas. No se retiran ni debilitan pruebas existentes.

Véase `VALIDATION.md` para distinguir lo ejecutado de lo pendiente.
