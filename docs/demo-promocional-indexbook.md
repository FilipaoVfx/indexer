# Demo Promocional de Indexbook

Guion base para un demo promocional en video, construido a partir de las features implementadas desde `c4b8d652a7001556f685d175ef9efa91b0fcf930` hasta el estado actual del workspace.

Duracion sugerida: `80-95 segundos`
Formato sugerido: `16:9`, ritmo rapido, cortes limpios, zooms suaves sobre UI, cursor visible solo cuando agrega contexto.

## Idea central

El demo debe contar esta transformacion:

`bookmarks dispersos en X -> conocimiento navegable -> rutas accionables -> repositorios y READMEs clasificados`

No conviene venderlo como un simple buscador. Lo mas potente del producto hoy es que convierte una coleccion caotica de bookmarks en una consola para descubrir, comparar y ejecutar herramientas reales.

## Secuencia de tomas

| # | Duracion | Toma en pantalla | Voz en off / copy sugerido | Feature que se demuestra |
| --- | --- | --- | --- | --- |
| 1 | 0-5s | Cold open con montaje rapido: home de la app, vista de pipeline, vista de repos, vista de READMEs. Fondo neobrutalist negro con cian y morado. | "Tus bookmarks ya no deberian vivir enterrados en una lista infinita." | Nueva identidad visual neobrutalist / arch-terminal. |
| 2 | 5-12s | Navegador en `x.com/i/bookmarks`. Se abre la extension y se hace click en `Scrape all bookmarks`. Mostrar el log avanzando. | "Indexbook captura tus bookmarks en lote y los convierte en un corpus consultable." | Flujo restaurado de scraping masivo desde la extension. |
| 3 | 12-18s | Scroll automatico en bookmarks mientras se ven nuevas cards siendo detectadas. Insert corto del backend recibiendo lotes o del contador subiendo. | "No solo recolecta: limpia, deduplica y preserva mejor el contenido real de cada referencia." | Ingesta por lotes, estabilidad del scraper, recuperacion de URLs completas y resolucion de shorteners. |
| 4 | 18-26s | Corte a la home de la consola. Hacer una busqueda hibrida y dejar que aparezcan `ResultCard` con avatar, texto largo expandible, multimedia y enlaces. | "Cada resultado llega con mas contexto: texto completo, autor, multimedia, enlaces y repos detectados." | ResultCard expandido: full text, avatar dinamico, media dropdown, enlaces enriquecidos. |
| 5 | 26-33s | Sobre una card, abrir `Ver repos mencionados`. Mostrar el modal con repos detectados y CTA hacia repo / README. | "Un post deja de ser una pieza aislada y pasa a revelar las herramientas que realmente menciona." | Source navigation y modal de repos mencionados en resultados. |
| 6 | 33-43s | Cambiar a modo `Por objetivo`. Escribir una meta en espanol, por ejemplo: `quiero montar un flujo de scraping, API y dashboard para leads`. Mostrar chips / parsing del objetivo. | "Describe lo que quieres construir en lenguaje natural, incluso en espanol." | Goal search unificado, expansion bilingue ES/EN, parsing orientado a objetivo. |
| 7 | 43-55s | Mostrar la vista `pipeline` con React Flow: pasos conectados de extraccion, almacenamiento, API, automatizacion y dashboard. Hacer click en 2-3 nodos. | "Indexbook traduce la necesidad en una ruta de implementacion, paso por paso." | Goal mode con pipeline visual, bucketing por pasos y camino recomendado. |
| 8 | 55-63s | En el panel de detalle del pipeline, enfocar `why_this_result`, preview de README y `siguiente paso sugerido`. | "Cada recomendacion explica por que aparece y como encaja con el siguiente paso." | README-aware ranking, detalle por paso, razonamiento visible. |
| 9 | 63-72s | Ir a `/repos`. Mostrar cards de repos. Abrir `ver menciones` y ensenar perfiles heuristicas: intent, sentiment, keywords y snippet contextual. | "Tambien puedes explorar el mapa de repos desde la conversacion real de la comunidad." | Vista de repos con panel heuristico de menciones. |
| 10 | 72-80s | Ir a `/authors`. Mostrar leaderboard lateral y abrir el modal de repos de un autor destacado. | "Y seguir a las personas que mas herramientas descubren, comparan y recomiendan." | Vista de autores, paginacion corregida, leaderboard y modal por autor. |
| 11 | 80-90s | Ir a `/readmes`. Buscar un repo puntual y mostrar el README cacheado. Si la capa mas nueva esta disponible, enfocar etiquetas de categoria, capacidades, entradas, salidas, stack y confianza. | "Detras del post, tambien vive la documentacion: READMEs cacheados y cada vez mas estructurados." | Extraccion de READMEs, explorador dedicado y clasificacion canonica de repos. |
| 12 | 90-95s | Cierre con montage rapido: extension -> search -> pipeline -> repos -> authors -> readmes. Terminar en logo/nombre. | "Indexbook convierte bookmarks en conocimiento accionable." | Cierre de producto / promesa central. |

## Orden narrativo recomendado

La pieza funciona mejor si sigue este orden:

1. Caos de origen.
2. Captura automatica.
3. Busqueda con contexto.
4. Descubrimiento estructurado.
5. Planeacion por objetivo.
6. Exploracion por repos, autores y documentacion.
7. Cierre con promesa de valor.

## Tono visual

- Mostrar siempre la UI real: el look terminal / neobrutalist ya es una ventaja visual.
- Evitar tomas largas del cursor escribiendo. Mejor usar jump cuts y texto ya parcialmente escrito.
- Priorizar queries en espanol para demostrar la expansion bilingue.
- Usar 1 o 2 repos conocidos dentro del dataset para que README, menciones y pipeline se sientan conectados.
- Si hay datos suficientes, elegir un caso de uso concreto: `lead gen`, `automatizacion`, `agentes`, o `search`.

## Setup antes de grabar

- Tener una cuenta / dataset con bookmarks ya sincronizados.
- Preparar una busqueda hibrida que devuelva cards con multimedia y repos detectados.
- Preparar una consulta en modo objetivo que produzca al menos 4 pasos en el pipeline.
- Tener listo un repo con README cacheado para la escena de `/readmes`.
- Si se quiere mostrar la capa mas nueva de clasificacion, aplicar `backend/sql/010_repo_classifier.sql` y correr los procesos de backfill / clasificacion antes de grabar.

## Version corta de 45 segundos

Si quieres una pieza mas compacta, conserva solo estas tomas:

1. Extension capturando bookmarks.
2. Busqueda hibrida con cards enriquecidas.
3. Modal de repos mencionados.
4. Goal mode en espanol.
5. Pipeline visual con detalle por paso.
6. Vista de READMEs con clasificacion.
7. Cierre con tagline.

## Taglines posibles

- `De bookmarks a decisiones.`
- `Tu conocimiento tecnico, indexado y accionable.`
- `Encuentra herramientas, rutas y contexto en un solo lugar.`
- `No guardes mas bookmarks. Construye con ellos.`
