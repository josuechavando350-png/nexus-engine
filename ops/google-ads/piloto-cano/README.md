# Piloto Cano para Google Ads

Secuencia de comandos para **EDUARDO CANO | ESTRATEGIA PENAL** (173-219-7237). Trabaja en pesos mexicanos y con la hora de Ciudad de México. Se entrega para revisión, con `MODO_PRUEBA: true`. Publicar estos archivos en GitHub no instala la secuencia.

## Instalación desde Android, después de la revisión

1. En Chrome abre el menú **⋮** y marca **Sitio para computadoras** (también puede llamarse **Versión de escritorio**). Desde la rama revisada abre [piloto-cano.js](./piloto-cano.js), toca **Raw** o **Ver sin formato** y copia todo el texto.
2. Entra en Google Ads y elige la cuenta **173-219-7237**. En **Herramientas → Acciones masivas → Secuencias de comandos** (en algunas interfaces, **Scripts**), toca **+** para crear una secuencia. Dale el nombre **Piloto Cano**. Mantén una sola copia programada.
3. Selecciona todo el código de ejemplo del editor y sustitúyelo por el archivo completo. Revisa al principio `MODO_PRUEBA: true`, el correo **nexusbotstudio349@gmail.com**, los IDs y los límites. Toca **Guardar**.
4. Toca **Autorizar**, selecciona la cuenta de Google que administrará la secuencia y revisa sus permisos para Google Ads, Drive, Hojas de cálculo y envío de correo. Regresa al editor tras autorizarlos.
5. Toca **Vista previa** y espera a que termine. Dentro de la hora de las 7 llega el reporte completo. A otras horas llega un correo de comprobación y, si corresponde, la alerta de la hora. El correo y la hoja funcionan tanto en vista previa como en modo de prueba.
6. Completa las comprobaciones de abajo. Para programarlo, vuelve a **Secuencias de comandos**, busca **Piloto Cano**, toca el lápiz de la columna **Frecuencia**, selecciona **Cada hora** y guarda. Comprueba que la frecuencia aparezca en la fila. Google puede iniciarlo en cualquier minuto de la hora.
7. Puede quedarse programado en modo de prueba. Para que aplique cambios después de la revisión humana, la persona responsable debe guardar `MODO_PRUEBA: false` en el editor. **Vista previa** sigue simulando incluso con ese valor.

## Comprobaciones del revisor

- [ ] La vista previa termina sin errores en **Historial de secuencias de comandos → Registros**. Verifica también la bandeja de entrada por si alguna tarea informó de un error y las demás continuaron.
- [ ] El mensaje en español llega a **nexusbotstudio349@gmail.com** con el enlace correcto. El correo de las 7 permite comparar ayer y los siete días completos con el informe de Google Ads.
- [ ] El enlace abre **Piloto Cano — Bitácora** con **Cambios**, **Alertas** y **Revisión**. Si no hubo candidatos, una pestaña puede contener sólo sus encabezados.
- [ ] En **Historial de cambios** de Ads, compara pujas y negativas antes y después. En vista previa y con **MODO_PRUEBA** las pujas y negativas siguen iguales. En la bitácora cualquier propuesta figura como **PRUEBA / Propuesto**.
- [ ] En el reporte de las 7 comprueba que sólo se cuenten las cinco acciones indicadas abajo. Contrasta una búsqueda con contactos, una con nombre de despacho y una con palabra protegida. Ninguna debe producir una negativa.
- [ ] El lunes contrasta pujas, prioridad, redondeo y fecha del último cambio real. Repetir la prueba durante la misma hora no debe duplicar las propuestas ni la lista de revisión.

## Qué hace y cuándo

| Hora de CDMX | Regla |
| --- | --- |
| Cada hora | Lee el gasto de hoy y los presupuestos diarios de las dos campañas. Si el gasto llega al **150%** de su suma, manda **un aviso como máximo ese día**. Un presupuesto compartido por ambas se cuenta una vez. |
| 18:00–18:59 | Si ayer más hoy suman **50 clics o más** y **0 contactos**, envía un aviso para revisar WhatsApp, teléfono y formulario de canopenal.com. |
| 07:00–07:59 | Revisa búsquedas, prepara las negativas permitidas y envía el reporte diario. Vuelve a comprobar el estado de medición para mostrar alertas vigentes. |
| Lunes 07:00–07:59 | Además revisa las pujas y envía un resumen semanal con un párrafo **Para el licenciado**, listo para reenviar. Compara el costo por contacto de los últimos siete días completos con los siete anteriores. |

El reporte diario incluye gasto, clics, contactos y costo por contacto de **ayer** y los **últimos 7 días completos**, con tablas por campaña y grupo, desglose por acción, las **10 búsquedas** con más contactos en **30 días completos**, negativas de hoy, búsquedas para revisión y alertas. Si hubo cero contactos, el costo por contacto queda sin calcular.

Un **contacto** es la suma de «Todas las conversiones» de estas acciones, comparando el nombre completo sin distinguir mayúsculas. Se conserva cualquier fracción atribuida por Google. Las acciones locales, cargas y vistas de página quedan fuera.

- WhatsApp - canopenal
- Clic telefono - canopenal
- Formulario web - canopenal
- Clicks to call
- Clics para llamar

### Campañas y grupos

| Campaña de búsqueda | ID |
| --- | --- |
| CL &#124; Leads-Search &#124; PENAL | 23231143138 |
| CL &#124; Amplia &#124; PENAL | 24441409357 |

| Grupo | ID | Prioritario |
| --- | --- | --- |
| PENAL | 196630631948 | |
| Me acusan | 198820133422 | Sí |
| Detenido | 199935531965 | Sí |
| Fraude | 200841963543 | Sí |
| Citatorio | 202207553512 | Sí |
| Orden de aprehensión | 201650830957 | |
| Local | 201650834797 | |
| Audiencia | 202515478798 | |
| AMPLIA | 201713888293 | |

### Negativas y revisión

Se conserva la defensa penal de cualquier delito y la atención a víctimas de delitos patrimoniales altos. Una negativa sólo puede ser **exacta** y pertenecer a la campaña donde apareció la búsqueda. El filtro evalúa búsquedas con **al menos 1 clic** en los **30 días completos anteriores**. Comprueba los **90 días, incluido hoy**, con fechas explícitas. Un contacto en cualquiera de las dos campañas protege la búsqueda en ambas. Una fracción de contacto también la protege.

- Las listas completas y editables `BASURA_SEGURA` y `PALABRAS_PROTEGIDAS` están al principio del script. El filtro compara en minúsculas y sin acentos. Por ejemplo, «me robaron mi celular» puede ser candidata. «Me acusan de robo de celular» y «fraude por extorsión telefónica» quedan protegidas.
- Para conservar nombres de otros abogados y despachos, el texto completo debe reconocerse como una expresión genérica de la lista, sola o con un complemento conocido, como «en CDMX». «Empleo García y Asociados» queda para revisión aunque contenga «empleo». También quedan para revisión las expresiones cuyo texto adicional sea ambiguo.
- La limpieza comprueba negativas directas y listas compartidas aplicables. Agrega la forma acentuada y la forma sin acentos cuando son distintas. Cada variante cuenta como **una** de las **10 negativas máximas por día** entre las dos campañas. Si faltan dos y sólo queda un lugar, ambas esperan. Un duplicado informado por Google se registra y el piloto continúa.
- Si hay contactos en las campañas que Google no permite asociar a búsquedas visibles, se suspende el bloqueo automático. La lista para revisión señala esa limitación. Los datos corresponden a lo que Google haya atribuido hasta la consulta.
- La lista de revisión muestra hasta **20** búsquedas por orden de gasto, con campaña, clics, gasto y motivo. Exige **3 clics o más**, cero contactos identificados en 90 días y que la búsqueda no se haya bloqueado ni propuesto ese día.

### Pujas del lunes

El objetivo es **$250 MXN por contacto**. Se usan **14 días completos**, al menos **20 clics** y **7 días desde el último cambio real de puja**. Las propuestas de prueba no inician esa espera. Se lee el CPC actual del grupo y se decide en este orden.

| Condición | Decisión |
| --- | --- |
| Al menos **3 contactos** y costo por contacto de hasta **$150** (60% del objetivo) | Subir **15%**. |
| Al menos **2 contactos** y costo por contacto de hasta **$200** (80%) | Subir **10%**. |
| **0 contactos y al menos 30 clics**, o costo por contacto de **$400 o más** (160%) | Bajar **10%** en grupos no prioritarios. En un grupo prioritario, indicar **revisar** en el correo. |

Cada nueva puja queda entre **$8 y $28 MXN**, redondeada a **2 decimales**. Si el límite impediría avanzar en la dirección indicada, se conserva el valor actual.

### Bitácora y alcance

**Cambios** conserva la fecha, el tipo, los IDs, la entidad, el antes y después, el motivo, el modo y el estado. Una operación real se reserva antes de solicitarla a Google. Si queda **Por confirmar**, compara la fila con el historial de Google Ads. La reserva cuenta para el límite de negativas del día o la espera de siete días en pujas. **Alertas** guarda la fecha, el tipo y el estado del envío para evitar duplicados. **Revisión** conserva la selección diaria. Mantén el orden cronológico de las pestañas y usa vistas de filtro para consultarlas.

El piloto sólo puede añadir negativas exactas de campaña y ajustar CPC de grupo. Mantiene los presupuestos, los estados de campañas, grupos, anuncios y palabras clave, el contenido de los anuncios, la segmentación, los horarios y la configuración de conversiones. Un error se informa por correo con la tarea y el enlace a la bitácora. Si Drive falla antes de abrir la hoja, el aviso incluye un enlace de búsqueda por nombre. El procesamiento de datos tiene un corte preventivo a los **26 minutos** para dejar margen antes del límite de Google.

[Instalación y programación en Google Ads](https://support.google.com/google-ads/answer/188712?hl=es-419) · [Funcionamiento de la vista previa](https://developers.google.com/google-ads/scripts/docs/preview?hl=es)
