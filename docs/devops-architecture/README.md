# Arquitectura DevOps — Indexer (Indexbook)

## Resumen Ejecutivo

Indexer es una plataforma de indexación semántica de bookmarks de X (Twitter) que permite búsqueda inteligente, clasificación de repositorios GitHub y visualización de conocimiento. El proyecto implementa prácticas DevOps mediante integración continua con GitLab CI/CD, validación automatizada de código y artefactos, y una arquitectura modular desplegable en VPS.

## Componentes del Proyecto

| Componente | Tecnología | Función |
|---|---|---|
| Frontend | Astro + React | Dashboard de búsqueda y visualización |
| Backend | Node.js (ES Modules) | API REST, ingesta y procesamiento |
| Extensión | Chrome Extension (Manifest V3) | Scraping de bookmarks en X/Twitter |
| Base de datos | Supabase (PostgreSQL) | Persistencia y búsqueda vectorial |
| CI/CD | GitLab CI/CD | Validación y build automatizados |
| Automatización | n8n | Flujos de ingesta ETL |
| Monitoreo | Prometheus + Grafana | Observabilidad del sistema |

## Estructura de Documentación

- [architecture.md](architecture.md) — Arquitectura general del sistema
- [tools-and-justification.md](tools-and-justification.md) — Justificación de herramientas
- [devops-flow.md](devops-flow.md) — Flujo DevOps completo
- [observability.md](observability.md) — Observabilidad real (Prometheus + Grafana + Supabase)
- [references.md](references.md) — Referencias académicas (APA 7)
- [diagrams/](diagrams/) — Diagramas de arquitectura en Mermaid

> La configuración operativa del stack de observabilidad (Prometheus, Grafana,
> node_exporter, dashboards y alertas) vive en [`observability/`](../../observability/).

## Beneficios de la Arquitectura DevOps

1. **Automatización**: Pipeline CI valida código, migraciones SQL y manifiestos de extensión en cada push.
2. **Calidad**: Linting, type checking y tests automáticos previenen regresiones.
3. **Reproducibilidad**: Builds generan artefactos consistentes (dist web, extensión empaquetada).
4. **Observabilidad**: Prometheus recolecta métricas y Grafana permite monitoreo visual.
5. **Escalabilidad**: Arquitectura modular permite escalar componentes independientemente.

## Referencias

Ver [references.md](references.md) para bibliografía completa en formato APA 7.
