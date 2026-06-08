# Reporte: razonamiento detras del escenario 3

## 1. Escenario analizado

Escenario original en `backend/data/repo-relationship-scenarios.md:49-60`:

- `gosom/google-maps-scraper`
- `vectorlyapp/bluebox`
- `maillab/cloud-mail`
- `arhamkhnz/next-shadcn-admin-dashboard`

Conclusion original:

> Sistema posible: un CRM self-hosted que extrae negocios de Google Maps, usa Bluebox para enriquecer datos desde sitios o APIs no documentadas, muestra los leads en un dashboard Next/Shadcn y envia correos desde Cloud Mail. Los datos podrian clasificarse por ciudad, rubro, rating, email encontrado y estado de contacto.

## 2. Respuesta corta

La conclusion no salio de una dependencia tecnica declarada entre esos repos. Salio de una inferencia funcional y de producto, basada en los README locales. Eso ademas coincide con la nota general del archivo fuente: en `backend/data/repo-relationship-scenarios.md:3` ya se dice que "Las relaciones son inferidas por proposito, no por dependencia tecnica declarada."

Dicho de otra forma:

- No fue "estos repos ya se integran entre si".
- Fue "estos repos cubren etapas consecutivas del mismo flujo de negocio".

## 3. Linea de pensamiento que lleva a esa conclusion

La linea mental fue esta:

1. Buscar una entidad central comun.
   La entidad comun aqui no era "codigo", "agentes" o "infraestructura". Era `lead de negocio local`.

2. Buscar una fuente clara de adquisicion de leads.
   `gosom/google-maps-scraper` encaja directo porque su README habla de extraer negocios, emails, reviews, websites, ratings y usarlo para lead generation y sales prospecting.

3. Buscar una capa de enriquecimiento posterior.
   `vectorlyapp/bluebox` encaja porque su README no se vende como scraper generico solamente, sino como motor para trabajar con closed APIs, UI interactions y reverse engineering de sitios. Eso sugiere una segunda fase: tomar el lead bruto y completar o validar datos.

4. Buscar una capa de activacion o contacto.
   `maillab/cloud-mail` encaja porque ofrece envio de email, API abierta, envio masivo y visualizacion. Eso lo convierte en una pieza razonable para outreach inicial.

5. Buscar una carcasa de producto o interfaz de operacion.
   `arhamkhnz/next-shadcn-admin-dashboard` encaja porque ya trae dashboards, incluido CRM Dashboard, y sirve como shell rapido para listar, filtrar, segmentar y operar leads.

6. Verificar si juntos cuentan una historia de producto completa.
   La historia completa quedo asi:
   `captura -> enriquecimiento -> gestion visual -> contacto`

7. Nombrar el sistema segun su funcion emergente, no segun la tecnologia.
   Por eso la etiqueta final fue `CRM de leads locales`, no "pipeline de scraping", no "ETL de negocios", y no "dashboard de scraping". La pieza que une todo es la operacion comercial sobre leads.

## 4. Evidencia puntual por repo

| Repo | Evidencia del README local | Rol inferido en el sistema |
|---|---|---|
| `gosom/google-maps-scraper` | `backend/data/repo-readmes/gosom__google-maps-scraper.md:22` habla de "Google Maps business leads, emails, reviews, phone numbers, websites, ratings". En `:24` dice "lead generation, local business research, sales prospecting, data enrichment". En `:122`, `:124` y `:321` deja claro que tiene muchos campos y salida flexible. | Fuente de adquisicion de leads locales. |
| `vectorlyapp/bluebox` | `backend/data/repo-readmes/vectorlyapp__bluebox.md:24-25` habla de `closed APIs` y `reverse engineer websites`. En `:75` describe un agente que automatiza web data extraction y cae a browser agent si no existe rutina previa. En `:89` mapea lenguaje natural a rutinas. | Enriquecimiento y obtencion de datos faltantes. |
| `maillab/cloud-mail` | `backend/data/repo-readmes/maillab__cloud-mail.md:11` lo presenta como servicio de correo sobre Cloudflare. En `:62` habla de envio de correo y envio masivo. En `:70` expone API abierta. En `:72` ofrece visualizacion. | Capa de outreach y operacion de correo. |
| `arhamkhnz/next-shadcn-admin-dashboard` | `backend/data/repo-readmes/arhamkhnz__next-shadcn-admin-dashboard.md:29` dice responsive. En `:33` trae dashboards preconstruidos. En `:67` explicita `CRM Dashboard`. En `:78` incluso menciona `Email Page`. | UI de gestion, clasificacion y seguimiento del CRM. |

## 5. Criterio de match entre terminos

## 5.1 Lo que si use de forma implicita

Use un match semantico por capas, no solo por palabras sueltas. Las capas fueron:

- `data_extraction`: terminos como `scrape`, `scraper`, `scraping`, `extract`, `google maps`, `business leads`.
- `data_enrichment`: terminos como `enrich`, `enrichment`, `closed APIs`, `reverse engineer`, `web data extraction`.
- `outreach`: terminos como `email`, `mail`, `crm`, `campaign`, `contact`.
- `visualization`: terminos como `dashboard`, `admin`, `crm dashboard`, `ui`, `next`.

En el escenario 3, los cuatro repos cubren exactamente esas cuatro capas.

## 5.2 Lo que no use como criterio principal

No use como criterio principal:

- que todos compartieran el mismo lenguaje o runtime
- que hubiera integracion oficial entre repos
- que fueran del mismo autor
- que usaran el mismo framework
- que el match fuera solo por keyword literal

Por ejemplo, `Cloud Mail` no contiene la palabra "CRM" como idea central, pero si contiene la capacidad que un CRM necesita para activar leads: correo, API y gestion.

## 5.3 Match por entidad de datos

Ademas del match por capa, hubo match por entidad.

La entidad implicita era algo como:

```txt
LeadLocal {
  nombre
  categoria
  ciudad
  direccion
  telefono
  sitio_web
  rating
  email
  fuente
  estado_contacto
}
```

Cada repo toca esa entidad desde un angulo distinto:

- `google-maps-scraper` produce gran parte de la ficha.
- `bluebox` completa o valida campos faltantes.
- `next-shadcn-admin-dashboard` la muestra y permite operarla.
- `cloud-mail` actua sobre ella enviando mensajes y registrando estado.

Ese match por entidad fue mas importante que el match por keyword.

## 6. Criterio formalizable y repetible

Si quisiera convertir ese razonamiento en un algoritmo, no lo modelaria como "palabras iguales = repos relacionados". Lo modelaria como una suma de cinco puntajes.

### 6.1 Rubrica propuesta

| Dimension | Pregunta | Peso sugerido |
|---|---|---|
| Cobertura de pipeline | Los repos cubren etapas consecutivas de un flujo? | 0.35 |
| Match de entidad | Trabajan sobre el mismo objeto de datos? | 0.25 |
| Compatibilidad de salida | Pueden pasarse datos por CSV, JSON, API o DB? | 0.15 |
| Encaje de producto | La combinacion se puede vender/entender como un solo producto? | 0.15 |
| Encaje operativo | Son razonables para un stack self-hosted o integrable? | 0.10 |

Formula sugerida:

```txt
scenario_score =
  0.35 * pipeline_coverage +
  0.25 * entity_match +
  0.15 * output_compatibility +
  0.15 * product_fit +
  0.10 * operational_fit
```

### 6.2 Aplicacion aproximada al escenario 3

Esta parte no fue calculada asi en el momento original; la explicito ahora para que quede trazable.

| Dimension | Puntaje estimado | Motivo |
|---|---|---|
| Cobertura de pipeline | 0.95 | Hay captura, enriquecimiento, UI y outreach. |
| Match de entidad | 0.90 | Todos convergen sobre el mismo lead o contacto, aunque el dashboard sea generico. |
| Compatibilidad de salida | 0.85 | Hay evidencia de CSV, JSON, API, REST, export y UI. |
| Encaje de producto | 0.95 | "CRM de leads locales" es una etiqueta natural, no forzada. |
| Encaje operativo | 0.80 | Varias piezas son self-hosted o facilmente desplegables, aunque no sean un stack unificado de fabrica. |

Resultado orientativo:

```txt
scenario_score ~= 0.91
```

Ese `0.91` no es una verdad matematica; solo muestra que la combinacion es fuerte cuando se mide por complementariedad funcional.

## 7. Match entre terminos y pasos canonicos

Tu repo ya tiene una forma bastante cercana de pensar esto en SQL.

En `backend/sql/008_goal_search_v3.sql:36-38` aparecen pasos canonicos como:

- `data_extraction`
- `data_enrichment`
- `outreach`
- `visualization`

Y en ese mismo archivo se mapean terminos a esos pasos:

- `scrape`, `scraper`, `scraping`, `extract` -> `data_extraction` (`backend/sql/008_goal_search_v3.sql:55-69`)
- `enrich`, `enrichment`, `enriquecer`, `normalize`, `validate` -> `data_enrichment` (`backend/sql/008_goal_search_v3.sql:71-81`)
- `email`, `mail`, `outreach`, `crm`, `campaign` -> `outreach` (`backend/sql/008_goal_search_v3.sql:158-168`)
- `dashboard`, `frontend`, `ui`, `react`, `next` -> `visualization` (`backend/sql/008_goal_search_v3.sql:170-185`)

Luego `backend/sql/009_goal_search_bilingual.sql` agrega expansion bilingue:

- `scrapear` -> `data_extraction` (`:35-38`)
- `correo`, `correos`, `contacto`, `campana` -> `outreach` (`:65-72`)
- `tablero`, `tableros`, `grafico` -> `visualization` (`:73-79`)

O sea: la intuicion del escenario 3 es coherente con la taxonomia que ya existe en la busqueda del proyecto.

## 8. Relacion con la heuristica actual del codigo

En `backend/src/knowledge.js` ya existe una heuristica ligera de matching:

- detecta intencion con `INTENT_PATTERNS` (`backend/src/knowledge.js:27`)
- detecta componentes con `COMPONENT_PATTERNS` (`backend/src/knowledge.js:35`)
- puntua coincidencias de terminos, frases, autor, dominio y presencia de GitHub en `scoreBookmarkAgainstQuery` (`backend/src/knowledge.js:182-253`)

Eso confirma que el proyecto ya piensa en match por:

- terminos
- componentes
- intencion
- razones explicables (`reasons`, `why_this_result`)

Lo que hice para el escenario 3 fue parecido, pero a nivel de sistema compuesto:

- no busque "el repo correcto"
- busque "la cadena de repos que completa el flujo"

## 9. Por que la conclusion final fue "CRM" y no otra cosa

Podia haberlo nombrado de varias formas:

- pipeline de scraping comercial
- stack de prospeccion local
- sistema de lead generation
- CRM de leads locales

Escogi `CRM de leads locales` porque:

- hay adquisicion de leads
- hay enriquecimiento de informacion
- hay dashboard de gestion
- hay envio de correo
- hay campos de estado de contacto

Cuando aparecen `lead + estado + dashboard + email`, la etiqueta `CRM` deja de ser cosmetica y pasa a describir la funcion del sistema.

## 10. Supuestos y limites

Hay que dejar claros algunos supuestos para no sobreinterpretar:

- No hay evidencia en el archivo de una integracion lista para usar entre estos repos.
- `Bluebox` aporta capacidad de extraccion/enriquecimiento, pero su uso debe respetar terminos de servicio y limites legales.
- `Cloud Mail` no convierte automaticamente el sistema en una plataforma de marketing completa; solo cubre bien la pieza de correo.
- `Next Shadcn Admin Dashboard` es una carcasa excelente para CRM, pero requiere modelo de datos y flujos de negocio propios.

## 11. Regla simple para repetir este analisis

Si quieres repetir esta clase de inferencia en otros grupos, esta regla funciona bien:

1. Identifica la entidad central.
2. Descompone el flujo en etapas canonicas.
3. Asigna cada repo a una etapa segun evidencia del README.
4. Verifica si comparten la misma entidad de datos.
5. Verifica si la combinacion produce una narrativa de producto comprensible.
6. Solo al final ponle nombre al sistema.

Aplicado aqui:

1. Entidad central: lead local.
2. Etapas: extraccion, enriquecimiento, visualizacion, contacto.
3. Repos asignados:
   `gosom` -> extraccion
   `bluebox` -> enriquecimiento
   `next-shadcn-admin-dashboard` -> visualizacion
   `cloud-mail` -> contacto
4. Entidad compartida: negocio/contacto.
5. Narrativa emergente: CRM de leads locales.

## 12. Conclusion final

Si lo resumo en una sola frase:

La conclusion se obtuvo porque los cuatro repos no coinciden por stack sino por complementariedad funcional alrededor del mismo objeto de negocio; juntos forman un flujo completo de prospeccion local, y esa completitud es lo que justifica llamarlo `CRM de leads locales con scraping, enriquecimiento y dashboard`.

