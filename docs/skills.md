# Skills instaladas para `indexbook`

Estas skills quedaron instaladas en `C:\Users\Filipo\.codex\skills` para reforzar el trabajo del buscador interno.

## Skills seleccionadas

### `qmd`

Ubicacion: `C:\Users\Filipo\.codex\skills\qmd\SKILL.md`

Por que se eligio:

- Es la mas alineada con un buscador interno local.
- Combina BM25, busqueda vectorial y busqueda hibrida.
- Sirve como referencia practica para decisiones de ranking, indexacion y recuperacion semantica.

Aplicacion directa en `indexbook`:

- Comparar la busqueda actual basada en `ilike` contra un enfoque BM25.
- Disenar una ruta de evolucion hacia embeddings y reranking.
- Definir colecciones o particiones por usuario, fuente o periodo.

### `ai-rag-pipeline`

Ubicacion: `C:\Users\Filipo\.codex\skills\ai-rag-pipeline\SKILL.md`

Por que se eligio:

- Ayuda a disenar pipelines de retrieval augmented generation.
- Introduce practicas de grounding, citas, busqueda iterativa y recuperacion con contexto.

Aplicacion directa en `indexbook`:

- Responder preguntas sobre bookmarks con contexto recuperado.
- Generar resumenes o clusters tematicos sobre resultados de busqueda.
- Crear flujos de `search -> retrieve -> rerank -> answer`.

### `web-search`

Ubicacion: `C:\Users\Filipo\.codex\skills\web-search\SKILL.md`

Por que se eligio:

- Aporta patrones de consulta avanzada, extraccion de contenido y enriquecimiento externo.
- Es util para contrastar resultados locales con resultados web cuando haga falta contexto adicional.

Aplicacion directa en `indexbook`:

- Enriquecer bookmarks con metadatos externos.
- Validar entidades, nombres, temas o enlaces rotos.
- Construir flujos de investigacion asistida.

### `llm-models`

Ubicacion: `C:\Users\Filipo\.codex\skills\llm-models\SKILL.md`

Por que se eligio:

- Facilita query rewriting, expansion semantica y reranking.
- Es util para experimentos de evaluacion y para convertir busquedas vagas en consultas mas utiles.

Aplicacion directa en `indexbook`:

- Reescribir consultas del usuario.
- Clasificar intencion de busqueda.
- Reordenar candidatos devueltos por el indice.

### `python-executor`

Ubicacion: `C:\Users\Filipo\.codex\skills\python-executor\SKILL.md`

Por que se eligio:

- Permite prototipos rapidos para analisis de datos, scraping y evaluacion de ranking.
- Es una buena base para experimentar con grafos, features y pipelines offline.

Aplicacion directa en `indexbook`:

- Analizar quality metrics de resultados.
- Probar grafos de relaciones entre autores, dominios, hashtags y enlaces.
- Evaluar heuristicas de ranking antes de pasarlas a produccion.

## Como se conectan con tu buscador

Estado actual observado:

- La busqueda en [store.js](C:\Users\Filipo\Documents\code\indexbook\backend\src\store.js) usa `ilike` sobre `text_content`, `author_username` y `author_name`.
- Eso resuelve el MVP, pero no cubre bien sinonimos, relevancia, expansion semantica ni relaciones entre entidades.

Evolucion recomendada:

1. Pasar de `ilike` a una combinacion de filtros estructurados + ranking.
2. Anadir una capa lexical tipo BM25 o `tsvector`/full text search de Postgres.
3. Incorporar embeddings para similitud semantica.
4. Hacer fusion de resultados lexicales y semanticos.
5. Anadir reranking con un modelo ligero o LLM solo sobre el top-N.
6. Modelar relaciones como grafo: usuario -> bookmark -> autor -> dominio -> tema -> enlace.

## Practicas recomendadas

- Mantener separadas las fases de `retrieve`, `filter`, `rank` y `rerank`.
- Medir calidad con consultas de prueba y no solo con impresiones manuales.
- Guardar features de ranking explicables: coincidencia exacta, frecuencia de terminos, frescura, autoridad del autor, popularidad del dominio, overlap semantico.
- Usar el grafo para expansion de consulta y recomendaciones relacionadas, no como reemplazo del indice principal.
- Limitar el reranking caro a pocos candidatos para mantener buena latencia.

## Nota operativa

Las skills de Codex se instalan globalmente en `C:\Users\Filipo\.codex\skills`, no dentro del repositorio. Este archivo deja trazabilidad local dentro de `indexbook`.
