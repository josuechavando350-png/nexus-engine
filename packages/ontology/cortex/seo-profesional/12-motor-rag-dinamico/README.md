# 12 — Motor RAG dinámico

`DynamicHeadlessEdgeRagEngine` es un handler Web portable que se puede montar desde Next.js App Router, Cloudflare Workers, Remix o Astro. El motor no depende del framework ni simula un modelo local dentro del repositorio.

## Grounding

La frontera `DynamicRagGroundingPort` está diseñada para consumir el `KnowledgeGraphReader.grounding()` canónico de Nexus o un servicio first-party que lo exponga. Un contexto `UNSUPPORTED` o `CONFLICTED` no llega al modelo. La respuesta del modelo debe ser JSON estricto y solo puede citar IDs que existan en el grounding verificado.

## Inferencia

Se incluyen dos adapters ejecutables:

- `CloudflareWorkersAiInference`: usa una binding compatible con `env.AI.run(model, input)`.
- `OpenAiCompatibleEdgeInference`: usa `fetch` HTTPS contra una API de inferencia ligera compatible con Chat Completions y obtiene el bearer token fuera del código.

Workers AI es inferencia administrada por Cloudflare; no se presenta como un modelo almacenado localmente dentro de Nexus.

## Límites

El motor limita bytes de consulta/contexto/respuesta, número de facts y tokens. No registra prompts ni datos personales por defecto. Las respuestas HTTP del RAG se marcan `private, no-store`.

La estrategia identifica el mismo origen HTTPS y plataforma que #11. Su salida entra al pipeline dinámico #13–#14 antes de volver a la superficie web de #1.
