# 15 — Cola FIFO distribuida

La estrategia separa dos semánticas que no deben confundirse:

- `UpstashQStashFifoQueue`: cola de indexación `STRICT_FIFO`. `ensureStrictFifo()` crea/actualiza la Queue con `parallelism: 1`; `enqueue()` usa un ID de deduplicación derivado del `eventId`.
- `CloudflareQueuesProducer`: adapter real a una binding Cloudflare Queue con semántica `AT_LEAST_ONCE_UNORDERED`. Se puede usar para cargas que toleran reordenamiento, pero `assertStrictFifo()` y `requireStrictFifoQueue()` rechazan usarla en la cadena #13 -> #15 -> #16.

Cloudflare Queues garantiza entrega al menos una vez, no orden de publicación. QStash Queue con paralelismo 1 sí documenta FIFO. Nexus conserva esa diferencia en tipos y en runtime en lugar de esconderla detrás de un nombre de producto.

Los eventos llevan `eventId`, secuencia, URL canónica, tipo de notificación, elegibilidad derivada de #13, recibo semántico SHA-256 y timestamp UTC. #15 no decide por sí mismo qué página puede entrar a Google; únicamente transporta eventos ya elegibles hacia #16.
