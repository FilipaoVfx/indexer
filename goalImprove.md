# GOAL SEARCH ENGINE — ARQUITECTURA SIN LLM (ALGORÍTMICA)

## 🎯 Objetivo

Diseñar un sistema que, a partir de un input tipo:

> "quiero construir un CRM con scraping y automatización de emails"

genere:

* rutas técnicas (pipelines)
* selección de repos/tools
* recomendaciones estructuradas

SIN usar LLMs, maximizando:

* indexación inteligente
* grafos
* matching híbrido (keyword + semántico clásico)

---

# 🧠 PRINCIPIO CLAVE

El sistema no debe buscar texto.

Debe responder:

> **"¿Cómo logro este objetivo con las piezas disponibles?"**

---

# 🧩 ARQUITECTURA GENERAL

```
INPUT (goal)
   ↓
GOAL PARSER
   ↓
STEP GENERATOR
   ↓
REPO MATCHING
   ↓
GRAPH BUILDER
   ↓
PATH RANKER
   ↓
OUTPUT (ruta recomendada)
```

---

# 1. 🧱 GOAL PARSER (SIN LLM)

Convierte texto libre en tokens útiles.

## Técnicas:

* lowercasing
* stopwords removal
* stemming / lemmatization (NLTK / spaCy)
* extracción de n-grams (bi/tri-grams)

## Output:

```json
{
  "tokens": ["crm", "scraping", "email", "automation"]
}
```

---

# 2. 🧩 STEP GENERATOR (REGLAS)

Mapea tokens → pasos del sistema

## Estrategia

Diccionario manual + reglas:

```json
{
  "scraping": "data_extraction",
  "crawler": "data_extraction",
  "email": "outreach",
  "automation": "workflow",
  "dashboard": "visualization",
  "storage": "database"
}
```

## Output:

```json
{
  "steps": [
    "data_extraction",
    "data_enrichment",
    "storage",
    "outreach",
    "visualization"
  ]
}
```

---

# 3. 🔎 REPO MATCHING

Para cada step → buscar repos relevantes

## Score híbrido

### 1. Keyword match

* `ILIKE`
* trigram similarity
* TF-IDF

### 2. Full-text search

* `tsvector` (Postgres)

### 3. Metadata match

* tools detectadas
* keywords extraídas
* categorías

---

## Fórmula de scoring

```txt
score =
  (0.4 * keyword_score) +
  (0.3 * fts_score) +
  (0.2 * metadata_score) +
  (0.1 * popularity_score)
```

---

# 4. 🧠 GRAPH BUILDER

Construye rutas posibles entre repos

## Tipos de relaciones

```txt
repo A → complements → repo B
repo A → alternative → repo C
repo A → next_step → repo D
```

## Fuente de relaciones

* co-ocurrencia en READMEs
* sharing de tools
* categorías similares
* mismos "steps"

---

## Ejemplo

```txt
scraper → enrichment → storage → email
```

---

# 5. 🛣️ PATH GENERATION

Combinar repos por step:

```txt
[repo1, repo2, repo3, repo4]
```

Generar múltiples combinaciones:

* top 3 por step
* combinaciones válidas

---

# 6. 📊 PATH RANKING

## Métricas

* cobertura de steps
* compatibilidad entre repos
* cohesión semántica
* simplicidad (menos pasos = mejor)

---

## Ejemplo scoring

```txt
path_score =
  coverage * 0.4 +
  compatibility * 0.3 +
  simplicity * 0.2 +
  repo_quality * 0.1
```

---

# 7. 📤 OUTPUT

```json
{
  "goal": "crm scraping",
  "recommended_path": [
    {
      "step": "data_extraction",
      "repo": "google-maps-scraper"
    },
    {
      "step": "enrichment",
      "repo": "bluebox"
    },
    {
      "step": "outreach",
      "repo": "cloud-mail"
    }
  ]
}
```

---

# ⚙️ MANEJO EFICIENTE DE README (CRÍTICO)

## 🎯 Objetivo

Convertir README → datos estructurados útiles

---

## 1. LIMPIEZA

Eliminar:

* badges
* imágenes
* HTML
* emojis innecesarios
* código irrelevante

Preservar:

* headings
* listas
* keywords técnicas

---

## 2. NORMALIZACIÓN

* lowercase
* eliminar ruido
* tokenización
* stemming

---

## 3. CHUNKING INTELIGENTE

Dividir por:

* headings (#, ##, ###)
* secciones lógicas

Evitar:

* chunks muy largos
* mezcla de temas

---

## 4. INDEXACIÓN MULTICAPA

### a) FULL TEXT

```sql
to_tsvector(content_text)
```

### b) TRIGRAM

```sql
gin_trgm_ops
```

### c) KEYWORDS

Extraer:

* herramientas (docker, api, cli)
* tecnologías (react, python, node)
* acciones (scrape, analyze, deploy)

---

## 5. EXTRACCIÓN DE FEATURES

Por README:

```json
{
  "tools": ["docker", "api"],
  "actions": ["scraping", "analysis"],
  "domain": "data"
}
```

---

## 6. HASHING Y VERSIONADO

* evitar reprocesar READMEs iguales
* usar hash del contenido

---

## 7. CACHE LOCAL

Guardar:

* README limpio
* chunks
* metadata

Evitar recalcular todo.

---

# ⚡ OPTIMIZACIONES CLAVE

## 🚀 Performance

* usar batch processing
* paralelizar extracción
* limitar queries pesadas

---

## 🎯 Precisión

* combinar FTS + trigram
* boost por coincidencias exactas
* penalizar ruido

---

## 🧠 Inteligencia sin LLM

* grafos
* reglas
* scoring heurístico
* co-ocurrencia

---

# 🔥 DIFERENCIAL DEL SISTEMA

Esto NO es:

* buscador de repos
* buscador semántico

Esto es:

> **un motor de ensamblaje de sistemas basado en objetivos**

---

# 🧠 ROADMAP

## MVP

* goal parser
* step generator (reglas)
* repo matching
* output simple

## V2

* grafo de relaciones
* ranking avanzado
* múltiples rutas

## V3

* simulación avanzada
* aprendizaje basado en uso

---

# 🧩 FRASE FINAL

> "No busques información. Construye soluciones a partir de ella."
