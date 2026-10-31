# Contenido editable

Edita solo value en content.json; expected conserva el texto observado y detecta discrepancias. textIndex identifica un nodo de texto directo, no reemplaza los elementos anidados.

Campos: 1763. Variantes entre estados: 53. Revisa catalog-evidence.json: se conserva la primera variante, no se inventa una regla para estados dinámicos.

El catálogo incluye texto y etiquetas observados. No detecta información incrustada en imágenes, vídeos, Canvas, código o respuestas API. No elimina los textos originales de los recursos conservados. Añade vínculos o imágenes como campos explícitos y comprueba las rutas.

Configura readySelector o readySelectors por ruta si la web tiene una señal de hidratación/preparación. La plantilla informa campos aplicados, ausentes y en conflicto en window.**BOT_MD_CONTENT**.

## Reproducción de los archivos referidos

Este documento es una muestra generada por Bot MD 0.3.0. Los JSON completos, hojas CSS y recursos a los que hace referencia se generan con los comandos del README; no están incrustados en este Markdown.
