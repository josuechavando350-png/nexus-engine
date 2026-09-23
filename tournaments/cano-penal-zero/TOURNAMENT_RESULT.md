# CANO — Resultado del Torneo Orgánico R0–R4

## Resultado actual

- Finalistas certificados por WALLE en R3: **S01 + S10 + S15**.
- Arquitectura combinada recomendada: **penal-fiscal + detenido/urgencia + diagnóstico/conversión**.
- Activo transversal conservado: **S05 calendario fiscal interactivo**, como soporte de autoridad y adquisición precrisis.
- Round 4: **BOOTSTRAP** porque Search Console fue configurado recientemente; no hay campeón comercial todavía.
- Meta: **>=5 clientes orgánicos firmados/mes**; repetibilidad: **3 meses consecutivos >=5**.
- **Mes 2:** al menos 1 cliente orgánico firmado; 0 activa diagnóstico inmediato.
- **Mes 3:** debe seguir habiendo clientes orgánicos y el objetivo operativo ya es **5 clientes firmados**.

## Blueprint de activos

### A01 — /

- Rol: GENERIC_PENAL_ENTRY
- Modo: STRENGTHEN_EXISTING
- Drivers: S10, S15
- Queries: K001 abogado penalista cdmx [TOP3]; K002 abogado penal cdmx [TOP3]; K003 abogados penalistas cdmx [TOP5]; K004 defensa penal cdmx [TOP5]; K005 despacho penal cdmx [TOP5]; K006 abogado penalista cerca de mi [TOP5]

### A02 — /areas/delitos-fiscales-y-financieros

- Rol: PENAL_FISCAL_HUB
- Modo: STRENGTHEN_EXISTING
- Drivers: S01
- Queries: K007 abogado defraudacion fiscal cdmx [TOP3]; K008 abogado delitos fiscales cdmx [TOP3]; K009 abogado penal fiscal cdmx [TOP3]; K010 abogado penal tributario cdmx [TOP5]; K011 defensa defraudacion fiscal [TOP5]; K012 defensa delitos fiscales mexico [TOP5]

### A03 — /guias/requerimiento-sat-riesgo-penal

- Rol: FISCAL_PRECRISIS
- Modo: PROPOSED_NEW
- Drivers: S01
- Queries: K013 requerimiento sat abogado [TOP3]; K014 carta invitacion sat abogado [TOP5]; K015 auditoria sat riesgo penal [TOP5]; K016 cuando un problema fiscal se vuelve penal [TOP3]

### A04 — /guias/responsabilidad-penal-representante-legal-contador

- Rol: PROFESSIONAL_EXPOSURE
- Modo: PROPOSED_NEW
- Drivers: S01
- Queries: K017 responsabilidad penal representante legal impuestos [TOP5]; K018 contador responsabilidad penal fiscal [TOP5]; K042 abogado para contador problema fiscal penal [TOP5]

### A05 — /detenido-cdmx

- Rol: URGENT_DETENTION
- Modo: PROPOSED_NEW
- Drivers: S10
- Queries: K019 abogado para detenido cdmx [TOP3]; K020 abogado detenido cdmx [TOP3]

### A06 — /citatorio-ministerio-publico-cdmx

- Rol: URGENT_CITATION
- Modo: PROPOSED_NEW_SUPPORTING
- Drivers: S10
- Queries: K021 abogado citatorio ministerio publico cdmx [TOP3]; K022 me citaron al ministerio publico necesito abogado [TOP5]

### A07 — /audiencia-inicial-control-detencion-cdmx

- Rol: URGENT_PROCEDURE
- Modo: PROPOSED_NEW
- Drivers: S10
- Queries: K023 abogado audiencia inicial cdmx [TOP3]; K024 abogado control de detencion cdmx [TOP5]

### A08 — /diagnostico-penal

- Rol: DIAGNOSTIC_CONVERSION
- Modo: PROPOSED_NEW
- Drivers: S15
- Queries: K027 consulta abogado penalista cdmx [TOP3]; K028 diagnostico penal abogado cdmx [TOP3]; K029 segunda opinion abogado penalista cdmx [TOP5]; K030 asesoria penal cdmx precio [TOP5]

### A09 — /guias/honorarios-abogado-penalista-cdmx

- Rol: PRICE_INTENT
- Modo: PROPOSED_NEW
- Drivers: S15
- Queries: K025 cuanto cuesta un abogado penalista cdmx [TOP5]; K026 honorarios abogado penalista cdmx [TOP5]

### A10 — /herramientas/calendario-fiscal

- Rol: FISCAL_AUTHORITY_TOFU
- Modo: PROPOSED_NEW_INTERACTIVE_SUPPORT
- Drivers: S01 + soporte S05
- Queries: K031 calendario fiscal mexico [TOP5]; K032 calendario fiscal 2026 mexico [TOP5]; K033 calendario obligaciones fiscales sat [TOP5]; K034 fechas declaraciones sat [TOP5]; K035 calendario fiscal personas morales [TOP5]; K036 calendario fiscal personas fisicas [TOP5]

### A11 — /guias/defensa-penal-empresa-delitos-financieros

- Rol: BUSINESS_WHITE_COLLAR
- Modo: PROPOSED_NEW
- Drivers: S01
- Queries: K037 abogado delito fiscal empresa cdmx [TOP3]; K038 defensa penal empresa cdmx [TOP5]; K039 abogado fraude empresarial cdmx [TOP5]; K040 abogado administracion fraudulenta cdmx [TOP5]; K041 abogado delitos financieros cdmx [TOP5]

## Orden de construcción

- **Wave 1 — BOFU core + calendario en paralelo:** A02, A05, A08, A01; y A10 (calendario fiscal interactivo) como producto paralelo que no retrasa las páginas de contratación.
- **Wave 2 — Urgent and fiscal depth:** A03, A06, A07, A09. Expand distinct high-intent queries without duplicating hubs.
- **Wave 3 — Authority expansion:** A04, A11. Representantes, contadores y defensa penal empresarial.

## Calendario fiscal interactivo (A10)

- Se desarrolla desde la primera ola, en paralelo con las páginas de contratación; no es un PDF ni una página de relleno.
- Acceso visible desde Inicio, navegación móvil y hub penal-fiscal.
- Vista por mes/año y filtros por tipo de contribuyente o régimen solo cuando los datos oficiales lo permitan.
- Cada vencimiento publicado debe enlazar su fuente oficial del SAT y mostrar la fecha de última verificación; fechas no verificadas no se publican.
- Enlaces contextuales hacia la defensa penal-fiscal y contacto, sin confundir un vencimiento con un delito ni imponer un formulario para usar la herramienta.
- Avisos opt-in solo si existe un envío funcional y consentimiento explícito.

## Gate de medición

- Search Console reciente = **BOOTSTRAP**, no fracaso.
- Alta confianza: **99.9%** cuando el tamaño de muestra lo permita.
- Potencia para comparación: **95%**.
- No cuentan como clientes: impresiones, clics, WhatsApps ni leads.
- El campeón comercial requiere asuntos firmados atribuibles a orgánico.

## Estado del campeón

**No hay campeón comercial todavía.** El mejor resultado estructural actual es el stack S01 + S10 + S15. Round 4 debe confirmar cuál aporta más clientes reales una vez maduren Search Console y la atribución.
