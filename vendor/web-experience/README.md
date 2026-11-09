# NEXUS Web Experience Kit

Biblioteca optativa de cuatro fuentes upstream reproducibles. Registrarlas no instala npm, no activa efectos en webs existentes y no las convierte en componentes listos para producción.

## Recursos

| ID | Upstream | Función |
| --- | --- | --- |
| `r3f-scroll-rig` | `14islands/r3f-scroll-rig` | Sincronizar DOM, scroll y WebGL |
| `seam-transitions` | `codrops/SeamTransitions` | Referencia de once demos de transición; requieren adaptación |
| `photoswipe` | `dimsemenov/PhotoSwipe` | Galerías ampliables y navegación táctil |
| `embla-carousel` | `davidjerleke/embla-carousel` | Carruseles y recorridos de proyectos |

El catálogo `catalog.json` fija la URL HTTPS, commit completo y SHA Git del blob `LICENSE`. Se conservan autoría y licencias de terceros, sin exclusividad para NEXUS.

## Comandos (Git y Node 24)

```sh
pnpm web-experience list                   # lista offline
pnpm web-experience verify all             # comprueba catálogo e ignorados, sin descargar
pnpm web-experience init photoswipe        # recupera una sola fuente
pnpm web-experience:init                   # recupera las cuatro
pnpm web-experience:verify                 # exige clones presentes y verificados
pnpm test:web-experience                   # contratos offline
```

Las fuentes se clonan bajo `vendor/web-experience/<id>/` únicamente al pedir `init`. Sus directorios y los temporales de descarga están **ignorados en Git**, no son submódulos ni entradas del índice. El catálogo, gestor y pruebas sí están versionados. Es necesario acceso a GitHub para la primera descarga; un clon nuevo del repositorio principal no incluye código upstream.

El gestor restringe URLs, rechaza protocolos locales, descarga sin checkout automático y después hace checkout explícito del SHA fijado, sin hooks. Verifica HEAD, limpieza, directorio real y blob `LICENSE`. No ejecuta scripts upstream ni instala dependencias npm. Un directorio inesperado, un commit diferente o cambios locales provocan error, nunca sobrescritura automática. La inicialización repetida no debe modificar la copia verificada.

## Adopción en una aplicación concreta

Las dependencias runtime van únicamente en la aplicación consumidora; por ejemplo:

```sh
pnpm --filter NOMBRE_DEL_APP add --save-exact photoswipe
pnpm --filter NOMBRE_DEL_APP add --save-exact embla-carousel
```

El paquete npm y su lockfile no son el mismo artefacto que el snapshot Git del catálogo. Revisar compatibilidad al implementar.

- **PhotoSwipe:** inicialización tras montaje, CSS local, enlaces HTML de respaldo, dimensiones y alt de imágenes, foco y `destroy()` al desmontar.
- **Embla:** controles accesibles y foco visible; no activar autoplay por defecto; no bloquear scroll normal; destruir instancia al desmontar.
- **Scroll Rig:** resolver React/Fiber/Three compatibles; montaje WebGL solo cliente, fallback HTML, movimiento reducido y medición de GPU/memoria móvil.
- **SeamTransitions:** demos de referencia, no un paquete instalable. Adaptar solo el efecto seleccionado; revisar GSAP, scripts, activos y licencias antes de copiar.

## Límites y licencias

En la revisión fijada de Scroll Rig, `LICENSE` declara **MIT** y `package.json` declara **ISC**. Esta discrepancia upstream requiere revisión por artefacto antes de uso comercial. Las licencias de las demos no cubren automáticamente plugins, fuentes, imágenes u otros activos.

Core, Experience Engine, Rust, NQC, apps de clientes, credenciales y despliegues permanecen intactos. El kit no certifica accesibilidad, SSR, rendimiento móvil ni comportamiento visual; se deben probar en cada web antes de habilitar efectos. No presentar las fuentes registradas como cuatro adaptadores productivos terminados.

El workflow `NEXUS Web Experience Sources` comprueba contratos Node 24, descarga real, SHA/LICENSE, repetición idempotente y limpieza del inventario Git. Ver `INTEGRATION.md` y `VALIDATION.md`.
