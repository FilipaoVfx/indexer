Aquí tienes el documento en formato `.md`, listo para usar en tu repo o en Obsidian 👇

---

```md
# INDEXER V2 — ROADMAP TÉCNICO (DE INDEXADOR → KNOWLEDGE ENGINE)

## 1. CONTEXTO

El sistema actual (`indexer`) cumple correctamente como:

- capturador de bookmarks (X / Twitter)
- pipeline de ingesta
- almacenamiento en Supabase
- búsqueda básica con ranking (FTS)

Sin embargo, la visión del producto apunta a:

> Un motor de conocimiento que conecta contenido, construye rutas y responde a objetivos.

---

## 2. PROBLEMA

El sistema actual responde a:

> "buscar texto dentro de bookmarks"

Pero el objetivo del producto es:

> "ayudar a construir soluciones a partir de conocimiento distribuido"

---

## 3. OBJETIVO DE ESTA VERSIÓN

Transformar el sistema de:

```

Bookmark Search Engine

```

a:

```

Knowledge Navigation Engine

```

---

## 4. GAP ACTUAL

### 4.1 Modelo de datos limitado
- Solo existe `bookmark`
- No hay semántica ni estructura de conocimiento

### 4.2 Sin capa semántica
- No hay embeddings
- No hay clasificación automática
- No hay extracción de entidades

### 4.3 Sin relaciones
- No existe grafo
- No hay conexiones entre assets

### 4.4 Búsqueda limitada
- Solo keyword + filtros
- No hay búsqueda por objetivo

### 4.5 UX básica
- No hay descubrimiento
- No hay rutas
- No hay contexto

---

## 5. VISIÓN V2

Sistema capaz de:

- entender contenido
- clasificar conocimiento
- conectar recursos
- responder a objetivos
- sugerir rutas

---

## 6. ARQUITECTURA V2

```

[EXTENSION] → [INGEST API] → [RAW BOOKMARKS]

```
                     ↓

             [ENRICHMENT PIPELINE]
             - classification
             - tagging
             - entity extraction
             - summarization
             - embeddings

                     ↓

            [KNOWLEDGE LAYER]
            - enriched assets
            - relations
            - graph

                     ↓

            [SEARCH LAYER]
            - keyword search
            - semantic search
            - goal-based search

                     ↓

            [FRONTEND UX]
            - discovery
            - routes
            - clusters
            - exploration
```

````

---

## 7. MODELO DE DATOS (V2)

### 7.1 Tabla: bookmarks (actual)
Se mantiene como raw ingestion.

### 7.2 Nueva tabla: knowledge_assets

```sql
id
bookmark_id
asset_type (thread | tool | repo | tutorial | paper | video)
title
summary
topics []
subtopics []
intent_tags []
difficulty (basic | intermediate | advanced)
canonical_url
domain
created_at
````

---

### 7.3 Tabla: entities

```sql
id
name
type (tool | framework | person | concept)
```

---

### 7.4 Tabla: asset_entities

```sql
asset_id
entity_id
```

---

### 7.5 Tabla: relations

```sql
id
source_asset_id
target_asset_id
relation_type
```

Tipos:

* relates_to
* requires
* alternative_to
* extends
* inspired_by
* same_goal_as

---

### 7.6 Embeddings

```sql
asset_id
embedding vector
```

---

## 8. ENRICHMENT PIPELINE

Se ejecuta después de cada sync.

### 8.1 Steps

1. Clean text
2. Summarize
3. Classify asset type
4. Extract topics
5. Extract entities
6. Detect intent
7. Generate embedding

---

### 8.2 Output

Convierte:

```
bookmark
```

en:

```
knowledge_asset
```

---

## 9. SEARCH SYSTEM

### 9.1 Tipos de búsqueda

#### A. Keyword search (actual)

* FTS + ranking

#### B. Semantic search

* embedding similarity

#### C. Goal-based search (NUEVO)

Input:

```
"quiero construir un buscador interno con grafos"
```

Pipeline:

1. parse intent
2. detect topics
3. detect required components
4. retrieve assets
5. rank by usefulness

Output:

```
- tools
- tutorials
- repos
- examples
- next steps
```

---

## 10. RANKING ENGINE

Score híbrido:

```
score =
  text_score +
  semantic_score +
  graph_score +
  freshness +
  authority +
  personal_signal
```

---

## 11. KNOWLEDGE GRAPH

### 11.1 Nodos

* assets
* entities
* topics

### 11.2 Relaciones

* asset ↔ asset
* asset ↔ entity
* asset ↔ topic

---

### 11.3 Funcionalidades

* related content
* exploration
* clustering
* route building

---

## 12. UX (V2)

### 12.1 Home

* contenido por defecto
* trending knowledge
* clusters
* rutas sugeridas

---

### 12.2 Search

* modo:

  * keyword
  * goal

---

### 12.3 Resultados

Cada resultado muestra:

* summary
* tags
* tipo
* dificultad
* "why this result"
* related assets

---

### 12.4 Nueva vista: ROUTE

Ejemplo:

```
Goal: Build recruiter agent

Step 1 → Read concept
Step 2 → Tools
Step 3 → Implementation
Step 4 → Optimization
```

---

## 13. ENDPOINTS NUEVOS

### 13.1 Search

```
GET /search?q=
GET /search/semantic?q=
POST /search/goal
```

---

### 13.2 Discovery

```
GET /discover
GET /clusters
GET /trending
```

---

### 13.3 Graph

```
GET /related/:id
GET /graph/:id
```

---

## 14. ROADMAP

### V1.5 — ENRICHMENT

* [ ] classification
* [ ] tagging
* [ ] summary
* [ ] domain extraction

---

### V2 — SMART SEARCH

* [ ] embeddings
* [ ] semantic search
* [ ] goal-based search

---

### V3 — GRAPH

* [ ] relations
* [ ] graph queries
* [ ] route generation

---

### V4 — UX

* [ ] discovery feed
* [ ] clusters
* [ ] routes UI
* [ ] connections view

---

## 15. PRIORIDADES

### ALTO IMPACTO

* enrichment pipeline
* embeddings
* goal-based search

---

### MEDIO

* graph
* ranking híbrido

---

### BAJO (pero diferencial)

* rutas
* visualización del grafo
* recomendaciones

---

## 16. DEFINICIÓN FINAL

Este sistema deja de ser:

> "un buscador de bookmarks"

y se convierte en:

> "un sistema operativo de conocimiento para construir soluciones"

---

```

---
