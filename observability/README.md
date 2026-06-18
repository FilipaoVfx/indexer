# Observabilidad — Indexer

Stack de monitoreo del proyecto: **Prometheus** (recolección) + **Grafana**
(visualización y alertas) + **node_exporter** (host del VPS), más el endpoint
nativo de métricas de **Supabase**.

```
                    VPS (este stack)
 ┌──────────────────────────────────────────────┐
 │  Prometheus ──► Grafana                        │
 │     ▲   ▲                                      │
 │     │   └──────── node_exporter (host)         │
 └─────┼────────────────────────────────────────┘
       │ scrape https + Bearer       │ scrape https + Basic auth
       ▼                             ▼
  Backend Node.js /metrics      Supabase /customer/v1/privileged/metrics
  (host SEPARADO)               (Postgres gestionado)
```

## Estructura

```
observability/
├── docker-compose.yml          # Prometheus + Grafana + node_exporter + blackbox
├── .env.example                # credenciales de Grafana
├── prometheus/
│   ├── prometheus.yml          # jobs (backend, supabase, node, blackbox, self)
│   └── rules/alerts.yml        # reglas de alerta (RED + host + DB + frontend)
├── blackbox/
│   └── blackbox.yml            # módulos de sondeo HTTP del frontend
├── grafana/provisioning/
│   ├── datasources/datasource.yml
│   └── dashboards/
│       ├── dashboards.yml
│       ├── indexer-backend.json    # RED + runtime Node.js
│       ├── indexer-supabase.json   # Postgres / Supabase
│       └── indexer-frontend.json   # uptime/SSL del frontend (blackbox)
└── secrets/                    # tokens reales (gitignored) — ver secrets/README.md
```

## Puesta en marcha (VPS limpio)

```bash
cd observability
cp .env.example .env                      # define GRAFANA_ADMIN_PASSWORD

# 1) Secrets (ver secrets/README.md)
printf '%s' "$(openssl rand -hex 32)" > secrets/indexer_metrics_token
printf '%s' 'eyJhbGciOi...service-role-jwt...' > secrets/supabase_service_role

# 2) Edita prometheus/prometheus.yml:
#    - target del job indexer-backend  -> tu host real del backend
#    - target del job supabase         -> TU_PROJECT_REF.supabase.co
#    - targets del job blackbox-http   -> URLs reales de GitHub Pages

# 3) Configura el backend con el MISMO token:
#    METRICS_TOKEN=<contenido de secrets/indexer_metrics_token>

docker compose up -d
```

- Grafana: `http://<vps>:3000` (admin / `GRAFANA_ADMIN_PASSWORD`) — dashboards
  ya provisionados en la carpeta **Indexer**.
- Prometheus: `http://<vps>:9090` → Status → Targets (todos deben estar `UP`).

## ¿Ya tienes Prometheus/Grafana en el VPS?

No necesitas `docker-compose.yml`. Solo:

1. Copia los bloques de `scrape_configs` de `prometheus/prometheus.yml` a tu
   `prometheus.yml`, y `rules/alerts.yml` a tu carpeta de reglas.
2. Coloca los secrets donde tu Prometheus los lea (`credentials_file` /
   `password_file`).
3. Importa los dashboards JSON desde Grafana → Dashboards → Import.
4. Recarga: `curl -X POST http://localhost:9090/-/reload`.

## Verificación rápida

```bash
# Backend expone métricas (con token):
curl -H "Authorization: Bearer $TOKEN" https://tu-backend.example.com/metrics | head

# Supabase responde:
curl -u "service_role:$SERVICE_ROLE_KEY" \
  https://TU_PROJECT_REF.supabase.co/customer/v1/privileged/metrics | head

# Sonda del frontend vía blackbox (debe incluir probe_success 1):
curl "http://localhost:9115/probe?module=http_2xx&target=https://tu-user.github.io/tu-repo/" | grep -E "probe_success|probe_http_status_code"
```

Detalle completo del catálogo de métricas, seguridad y runbook en
[`../docs/devops-architecture/observability.md`](../docs/devops-architecture/observability.md).
