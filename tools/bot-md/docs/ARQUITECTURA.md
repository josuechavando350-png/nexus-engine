# Arquitectura implementada

## Flujo

1. `common.config` valida URL, límites, viewports y escenarios.
2. `capture` abre contextos nuevos por página/viewport y registra respuestas GET con un presupuesto de recursos. `network` rechaza métodos de escritura, redes privadas por defecto y WebSockets. La excepción `allowLocalhost` admite exclusivamente localhost/loopback para pruebas.
3. `browser` recorre la página para provocar carga diferida dentro de un límite, vuelve arriba, ejecuta el escenario y extrae evidencia. Los valores están vinculados al estado, viewport, URL y fecha del manifiesto.
4. `build` comprueba integridad, reescribe rutas y empaqueta recursos. Conserva el HTML inicialmente servido, necesario para que el JavaScript original arranque sin duplicar hidratación. El DOM renderizado queda como evidencia, no como reemplazo silencioso del documento.
5. `server` sirve únicamente el índice local de rutas. No hace proxy al origen. Las respuestas API registradas se sirven como fixtures GET.
6. `verify` abre la copia con conexiones externas bloqueadas, repite los mismos pasos y compara imágenes, geometría, texto y aserciones. Crea salidas nuevas sin editar la referencia.
7. `repair` compara estilos entre evidencia y copia, propone únicamente propiedades constantes en el conjunto observado y conserva o revierte cada intento tras verificar todos los estados.

## Decisiones

- Preservar el código entregado evita regenerar por intuición lo que ya se recuperó. No equivale a recuperar código fuente no publicado, componentes originales ni servicios del servidor.
- Los recursos externos usan un espacio local separado por hash de origen, manteniendo sus rutas relativas.
- Las transformaciones JavaScript utilizan un parser de sintaxis y solo cambian literales de URL absoluta observados; no sustituyen texto arbitrario en expresiones regulares o comentarios.
- El parche de red traduce únicamente URLs conocidas de `fetch` y XHR. Las dependencias desconocidas se reportan.
- Cada contexto usa locale es-MX, zona UTC, escala 1, tema claro y movimiento reducido. Los viewports etiquetados como mobile son tamaños de pantalla; no se emula todo el hardware de un teléfono.
- El comparador usa el mismo navegador para la referencia y la reconstrucción. Los resultados no se extrapolan a otro motor.
- Los hashes son control de integridad, no una firma de terceros. Si alguien cambia datos y vuelve a calcular todos los hashes, puede crear otra referencia; no se presenta como evidencia resistente a un adversario con acceso de escritura completo.

## Límites operativos

Máximo predeterminado: 3 páginas, 8 estados por página/viewport, 5.000 elementos por estado, 20 MiB por recurso, 200 MiB de recursos y 12 pasos de scroll. Las páginas de más de 30.000 px de altura se rechazan para evitar generar capturas desproporcionadas. Los límites se registran y los truncamientos se muestran; no se interpretan como cobertura total.

La lectura de un cuerpo de respuesta ocurre antes de comprobar su tamaño real cuando el servidor no declara un Content-Length útil. El presupuesto no sustituye límites de memoria del proceso. Un despliegue multiusuario necesita contenedores por trabajo, cuotas de CPU/memoria/tiempo y filtrado de red a nivel de infraestructura, además de las comprobaciones DNS de esta CLI. Esta versión se entrega para ejecución local y no debe exponerse como servicio público sin esa capa.

Las páginas se ejecutan en un perfil limpio; no se importan sesiones personales. Los escenarios y las rutas deben revisarse antes de ejecutar sobre aplicaciones que puedan realizar efectos mediante solicitudes GET.

## Evolución prioritaria

1. Corpus de sitios públicos reales con permiso, incluidos sitios server-rendered, SPA y casos con dependencias dinámicas.
2. Fuentes de referencia adicionales: código fuente aportado por el propietario, exportaciones y fixtures de API.
3. Generador opcional de componentes con contrato estructurado y evaluación independiente; requiere elegir proveedor y probar costo/calidad.
4. Captura por frames, shadow roots y movimiento, y adaptación de import maps/URLs dinámicas.
5. Aislamiento de trabajos y una interfaz de operación, cuando el motor tenga evidencia suficiente en sitios reales.

## Incorporado en 0.2.0 tras la prueba pública

- Transporte explícito mediante proxy y confianza de CA configurada, separado de la verificación local.
- Señales de preparación por ruta y registro/restauración del scroll observado.
- Conservación de encabezados de enrutamiento Next.js; cancelaciones de precarga registradas por separado de solicitudes ausentes.
- Recorrido recursivo de dependencias CSS, preservación de `crossorigin` en precargas y obtención de RSC como bytes HTTP para evitar texto mal decodificado por CDP.
- Capturas derivadas con procedencia: se conservan hashes y observaciones de la captura madre.
- Registro de condiciones hover/pointer y corrección del cambio involuntario causado por desconectar la sesión CDP. Reproducción explícita para contrastar las referencias antiguas.
- Verificación concurrente acotada y resultados incrementales por estado.
