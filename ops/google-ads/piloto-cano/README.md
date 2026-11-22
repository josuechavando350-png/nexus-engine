# Piloto Cano para Google Ads

Secuencia de comandos para **EDUARDO CANO | ESTRATEGIA PENAL** (173-219-7237). Trabaja en pesos mexicanos y con la hora de Ciudad de México. Se entrega para revisión, con `MODO_PRUEBA: true`. Publicar estos archivos en GitHub no instala la secuencia.

## Instalación desde Android, después de la revisión

1. En Chrome abre el menú **⋮** y marca **Sitio para computadoras** (también puede llamarse **Versión de escritorio**). Desde la rama revisada abre [piloto-cano.js](./piloto-cano.js), toca **Raw** o **Ver sin formato** y copia todo el texto.
2. Entra en Google Ads y elige la cuenta **173-219-7237**. En **Herramientas → Acciones masivas → Secuencias de comandos** (en algunas interfaces, **Scripts**), toca **+** para crear una secuencia. Dale el nombre **Piloto Cano**. Mantén una sola copia programada.
3. Selecciona todo el código de ejemplo del editor y sustitúyelo por el archivo completo. Revisa al principio `MODO_PRUEBA: true`, el correo **nexusbotstudio349@gmail.com**, los IDs y los límites. Toca **Guardar**.
4. Toca **Autorizar**, selecciona la cuenta de Google que administrará la secuencia y revisa sus permisos para Google Ads, Drive, Hojas de cálculo y envío de correo. Regresa al editor tras autorizarlos.
5. Toca **Vista previa** y espera a que termine. A cualquier hora llega un informe de vista previa que incluye las tareas diarias, las del lunes y la comprobación de medición. Las alertas de la simulación aparecen dentro de ese correo. La vista previa puede crear la bitácora y sus encabezados. Las propuestas se calculan en memoria y se muestran en el mensaje.
6. Completa las comprobaciones de abajo. Para programarlo, vuelve a **Secuencias de comandos**, busca **Piloto Cano**, toca el lápiz de la columna **Frecuencia**, selecciona **Cada hora** y guarda. Comprueba que la frecuencia aparezca en la fila. Google puede iniciarlo en cualquier minuto de la hora.
7. Puede quedarse programado en modo de prueba. Para que aplique cambios después de la revisión humana, la persona responsable debe guardar `MODO_PRUEBA: false` en el editor. **Vista previa** sigue simulando incluso con ese valor.

## Comprobaciones del revisor

- [ ] La vista previa termina sin errores en **Historial de secuencias de comandos → Registros**. Verifica también la bandeja de entrada por si alguna tarea informó de un error y las demás continuaron.
- [ ] El mensaje en español llega a **nexusbotstudio349@gmail.com** con el enlace correcto. La sección **Comprobación de campañas contra la suma de sus grupos** contrasta gasto, clics y cada acción de contacto para ayer, 7 y 14 días. Si una fila dice **Revisar**, compara esas cifras con Google Ads usando las mismas fechas, zona y acciones.
- [ ] El enlace abre **Piloto Cano — Bitácora** con **Cambios**, **Alertas** y **Revisión**. Si no hubo candidatos, una pestaña puede contener sólo sus encabezados.
- [ ] En **Historial de cambios** de Ads, compara pujas y negativas antes y después. En vista previa y con **MODO_PRUEBA** las pujas y negativas siguen iguales. En la vista previa las propuestas aparecen sólo en el correo. En una ejecución programada en modo de prueba se guardan como **PRUEBA / Propuesto**.
- [ ] En el reporte de las 7 comprueba que sólo se cuenten las cinco acciones indicadas abajo. Contrasta una búsqueda con contactos, una con nombre de despacho y una con palabra protegida. Ninguna debe producir una negativa.
- [ ] En cualquier vista previa contrasta la simulación del lunes con los 14 días completos anteriores a hoy. Comprueba prioridad, redondeo y fecha del último cambio real. Dos vistas previas con los mismos datos deben dar las mismas decisiones y dejar intactos los cupos, los avisos y las filas de revisión de la programación.

### Pruebas reproducibles de las reglas

La vista previa comprueba **52 casos** con datos ficticios antes de consultar las métricas. Si una decisión difiere de su resultado esperado, informa el caso que falló. Estos ejemplos también pueden verificarse con Node desde la raíz del repositorio, con sus dependencias instaladas. El comando extrae sólo las funciones de cálculo y les pasa datos locales. No carga el archivo como programa ni invoca `main`.

```bash
node <<'JS'
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const ruta = 'ops/google-ads/piloto-cano/piloto-cano.js';
const ast = ts.createSourceFile(ruta, fs.readFileSync(ruta, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const nombres = new Set(('limpio normal claveDeProteccion obtener mismaCantidad sumaTerminos fuenteCompleta ' +
  'resolverCobertura formasGenericas indiceNegativas indexarNegativa yaExcluida evaluarBusqueda reglaPuja ' +
  'calcularPuja enEspera diferenciasDeTotales alertaDeGasto alertaDeMedicion soloSimular comprobarReglas').split(' '));
const funciones = ast.statements.filter(n => ts.isFunctionDeclaration(n) && nombres.has(n.name.text));
if (funciones.length !== nombres.size) throw new Error('Falta una función de cálculo');
const codigo = funciones.map(n => n.getText(ast)).join('\n');
const resultado = vm.runInNewContext(codigo + '\ncomprobarReglas()', {DIA: 86400000},
  {timeout: 2000, contextCodeGeneration: {strings: false, wasm: false}});
if (resultado !== 52) throw new Error('Número de casos inesperado');
console.log(resultado + ' comprobaciones correctas');
JS
```

| Caso que puede contrastar el revisor | Decisión esperada |
| --- | --- |
| Un informe identifica 1 contacto y otro 2, incluidos el primero y el mismo total de campaña de 2 | Proteger ambos términos. El total es 2. |
| La campaña informa 3 contactos y sólo hay nombres para 2, o las fuentes atribuyen el mismo contacto a términos incompatibles | Mantener la limpieza en revisión y mostrar en el correo la campaña, la acción y los días afectados. |
| Una búsqueda con contacto en la otra campaña, incluso si cambia el acento o la puntuación | Conservarla en ambas campañas. |
| «denuncia en línea» necesita dos variantes y queda un solo lugar | Esperar. Al quedar dos lugares se pueden proponer las dos. |
| Un grupo prioritario llega a 30 clics y cero contactos | Indicar **revisar** y conservar su puja. |
| Un grupo apto para subir 15% parte de $13.90 | Proponer $15.99. Un cambio real hace menos de siete días bloquea la propuesta. |

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
- La limpieza comprueba negativas directas y listas compartidas aplicables. También reconoce búsquedas que ya cubre una negativa de frase o amplia. Agrega la forma acentuada y la forma sin acentos cuando son distintas. Cada variante cuenta como **una** de las **10 negativas máximas por día** entre las dos campañas. Si faltan dos y sólo queda un lugar, ambas esperan. Un duplicado informado por Google se registra y el piloto continúa.
- El piloto coteja los contactos por **campaña, día e identificador de la acción**. Si el informe por grupo queda corto, consulta el informe de búsquedas por campaña. Para cerrar la diferencia, una vista debe explicar el total e incluir los contactos identificados por la otra. El correo muestra cuántas diferencias resolvió. Si aún falta un término, hay una corrección negativa o las cifras se contradicen, conserva todas las búsquedas de ambas campañas y muestra dónde revisar. Un contacto oculto podría pertenecer a cualquiera de ellas. El guardián, los reportes y la evaluación de pujas siguen su propio horario. Los datos corresponden a lo que Google ha atribuido hasta la consulta.
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

**Cambios** conserva la fecha, el tipo, los IDs, la entidad, el antes y después, el motivo, el modo y el estado. Una operación real se reserva antes de solicitarla a Google. Si queda **Por confirmar**, compara la fila con el historial de Google Ads. La reserva cuenta para el límite de negativas del día o la espera de siete días en pujas. **Alertas** guarda la fecha, el tipo y el estado del envío para evitar duplicados. **Revisión** conserva la selección diaria de las ejecuciones programadas. La vista previa puede consultar las reservas reales, pero no consume el tope diario, la espera de siete días ni el aviso de las 18:00. Si falta cupo para enviar correo se detienen los cambios reales. Si el piloto necesita crear una bitácora en modo real y no dispone del bloqueo nativo entre ejecuciones, esa primera ejecución sólo propone cambios. Mantén el orden cronológico de las pestañas y usa vistas de filtro para consultarlas.

El piloto sólo puede añadir negativas exactas de campaña y ajustar CPC de grupo. Mantiene los presupuestos, los estados de campañas, grupos, anuncios y palabras clave, el contenido de los anuncios, la segmentación, los horarios y la configuración de conversiones. Un error se informa por correo con la tarea y el enlace a la bitácora. Si Drive falla antes de abrir la hoja, el aviso incluye un enlace de búsqueda por nombre. El procesamiento de datos tiene un corte preventivo a los **26 minutos** para dejar margen antes del límite de Google.

[Instalación y programación en Google Ads](https://support.google.com/google-ads/answer/188712?hl=es-419) · [Funcionamiento de la vista previa](https://developers.google.com/google-ads/scripts/docs/preview?hl=es) · [Informe de búsquedas por campaña y campos admitidos](https://developers.google.com/google-ads/api/fields/v24/campaign_search_term_view) · [Qué muestra el informe de términos de búsqueda](https://support.google.com/google-ads/answer/2472708?hl=es)
