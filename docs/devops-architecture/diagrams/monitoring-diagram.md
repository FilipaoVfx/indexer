# Diagrama de Monitoreo y Observabilidad

Topología real implementada: el backend corre en un **host separado** del VPS y
se scrapea por internet con token Bearer; Supabase expone su endpoint nativo de
métricas; el host del VPS se monitorea con node_exporter. Detalle completo en
[`../observability.md`](../observability.md).

```mermaid
graph TB
    subgraph APP["Host del backend (separado)"]
        BE["Backend Node.js<br/>GET /metrics (Bearer)"]
    end

    subgraph SUPA["Supabase (PostgreSQL gestionado)"]
        SB["/customer/v1/privileged/metrics<br/>Basic auth: service_role"]
    end

    subgraph FE["Frontend (GitHub Pages, estático)"]
        WEB["Páginas Astro"]
    end

    subgraph VPS["VPS — stack de observabilidad"]
        NE["node_exporter :9100"]
        BB["blackbox_exporter :9115"]
        PROM["Prometheus :9090<br/>scrape + rules"]
        GRAF["Grafana :3000<br/>dashboards + alertas"]
    end

    BE -->|https + Bearer| PROM
    SB -->|https + Basic| PROM
    NE -->|http| PROM
    PROM -->|/probe| BB
    BB -->|https GET| WEB
    PROM -->|datasource| GRAF
    GRAF -->|alertas| NOTIFY["Notificaciones"]
```

## Métricas recolectadas

```mermaid
graph LR
    PROM["Prometheus"] --> RED["RED — API<br/>indexer_http_requests_total<br/>indexer_http_request_duration_seconds<br/>indexer_http_requests_in_flight"]
    PROM --> RUN["Runtime Node.js<br/>memoria RSS / heap<br/>event-loop lag<br/>CPU seconds"]
    PROM --> BIZ["Negocio<br/>indexer_bookmarks_ingested_total<br/>indexer_search_requests_total"]
    PROM --> DB["Postgres / Supabase<br/>pg_stat_database_*<br/>conexiones, cache, tamaño"]
    PROM --> HOST["Host / VPS<br/>node_cpu / memory / filesystem"]
    PROM --> WEB["Frontend / GitHub Pages<br/>probe_success / probe_duration<br/>probe_http_status / SSL expiry"]
```

## Ciclo de retroalimentación

```mermaid
graph LR
    GRAF["Grafana detecta anomalía"] --> ISSUE["Nuevo Issue"]
    ISSUE --> FIX["Fix en código"]
    FIX --> PIPELINE["Pipeline CI/CD"]
    PIPELINE --> DEPLOY["Deploy backend"]
    DEPLOY --> GRAF
```
