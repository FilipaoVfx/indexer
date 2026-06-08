# Arquitectura del Sistema — Indexer

## Introducción

Indexer (Indexbook) es una plataforma que permite indexar, buscar y clasificar bookmarks de X (Twitter) utilizando búsqueda semántica. El sistema extrae datos mediante una extensión de Chrome, los procesa a través de un backend Node.js, los almacena en Supabase (PostgreSQL) y los presenta en un dashboard web construido con Astro y React.

## Objetivos DevOps

| Objetivo | Implementación en Indexer |
|---|---|
| Automatización | Pipeline GitLab CI/CD ejecuta validación y build en cada push |
| Integración Continua | Validación de backend, extensión y frontend en paralelo |
| Entrega Continua | Artefactos generados automáticamente (dist web, extensión .zip) |
| Observabilidad | Prometheus para métricas, Grafana para dashboards |
| Seguridad | Variables de entorno para secrets, service role keys en backend |
| Escalabilidad | Componentes desacoplados desplegables independientemente |

## Arquitectura General

### Frontend (web-astro)

- **Framework**: Astro 5.x con integración React
- **Componentes**: SearchApp, GoalPipelineView, ReposList, AuthorsList
- **Librerías**: @xyflow/react para visualización de grafos
- **Páginas**: Index (búsqueda), Authors, Repos, Readmes

### Backend

- **Runtime**: Node.js 20 (ES Modules)
- **Dependencias**: @supabase/supabase-js, dotenv
- **Servicios**: API REST (server.js), migración de datos, fetch de READMEs GitHub, clasificador de repositorios
- **Puerto**: Configurable (default 8787)

### Extensión de Chrome

- **Manifest**: V3
- **Funcionalidad**: Scraping de bookmarks en X/Twitter
- **Componentes**: Background service worker, content script, popup, page-bridge
- **Permisos**: storage, tabs, activeTab, scripting

### Base de Datos (Supabase)

- **Motor**: PostgreSQL
- **Migraciones**: 13 archivos SQL versionados (001 a 013)
- **Funcionalidades**: Schema de bookmarks, búsqueda vectorial, goal search, clasificación de repos, ETL electoral

### Automatización (n8n)

- Flujos de ingesta ETL para procesamiento de datos
- Integración con YouTube y fuentes externas

### Observabilidad

- **Prometheus**: Recolección de métricas del sistema
- **Grafana**: Visualización y alertas

## Flujo Completo: Desde Commit hasta Despliegue

1. **Desarrollo local** → Developer trabaja en feature branch
2. **Commit & Push** → Código se sube a GitLab
3. **Pipeline CI** → GitLab CI/CD ejecuta stages `validate` y `build`
4. **Validación** → Lint, typecheck, tests, verificación de migraciones SQL y manifest
5. **Build** → Generación de artefactos (dist web, extensión empaquetada)
6. **Despliegue** → Artefactos se despliegan a VPS
7. **Ejecución** → Backend sirve API, frontend sirve dashboard
8. **Monitoreo** → Prometheus recolecta métricas, Grafana visualiza

## Variables de Entorno Críticas

| Variable | Propósito |
|---|---|
| SUPABASE_URL | Endpoint de Supabase |
| SUPABASE_SERVICE_ROLE_KEY | Acceso privilegiado al backend |
| BOOKMARKS_TABLE | Tabla configurable para bookmarks |
| BOOKMARK_DEDUPE_SCOPE | Scope de deduplicación (per_user/global) |
| GITHUB_TOKEN | Acceso a GitHub API |
