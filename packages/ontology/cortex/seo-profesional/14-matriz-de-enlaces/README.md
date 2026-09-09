# 14 — Matriz de Enlaces

`EdgeCompiledLinkMatrix` mantiene matrices versionadas de enlaces first-party y las inyecta en HTML antes de entregar la respuesta. Solo admite destinos HTTPS del mismo origen canónico, elimina fragmentos, rechaza duplicados, limita tamaño y escapa etiquetas/atributos.

## Stores

- `CloudflareKvLinkMatrixStore`: adapter directo a una binding Workers KV. KV prioriza lecturas globales rápidas pero es eventualmente consistente; una escritura puede tardar en verse desde otras ubicaciones. No se usa para coordinación transaccional.
- `UpstashRedisRestLinkMatrixStore`: adapter HTTPS para Redis REST mediante comandos `GET`/`SET` autenticados. Es útil cuando la matriz requiere una ruta de actualización diferente a KV sin meter sockets Node en el Edge.

El HTML puede declarar `<!-- NEXUS_LINK_MATRIX -->`; si no existe, el bloque se inserta antes de `</body>`. La inyección es idempotente mediante `data-nexus-link-matrix="v1"`.

#14 recibe HTML semántico de #13 y entrega la landing enlazada al circuito web existente. No genera granjas de enlaces, enlaces externos ni doorway pages.
