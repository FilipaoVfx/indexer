# Conectar Prometheus del VPS con toda la data de Indexer

Guía operativa paso a paso para que el **Prometheus que corre en el VPS** reciba
métricas de las cuatro fuentes:

1. **Backend** Node.js (host separado, HTTPS + token Bearer en `/metrics`)
2. **Supabase / Postgres** (endpoint nativo `/customer/v1/privileged/metrics`)
3. **Host del VPS** (node_exporter)
4. **Frontend** GitHub Pages (blackbox_exporter)

> Topología: el backend corre en **otro host**; Prometheus lo alcanza por internet.
> Documentación de diseño: [`../docs/devops-architecture/observability.md`](../docs/devops-architecture/observability.md).

---

## 0. Antes de empezar — ten a mano

| Dato | De dónde sale |
|---|---|
| Host público del **backend** (ej. `api.tudominio.com`) | donde corre el Node.js |
| **METRICS_TOKEN** del backend | se genera en el Paso 2 |
| **PROJECT_REF** de Supabase + **service_role key** | Supabase → Project Settings → API |
| URL(s) del **frontend** (GitHub Pages) | tu sitio publicado |
| Acceso SSH al VPS | `ssh usuario@tu-vps` |

**Decisión clave:** ¿tu Prometheus corre con **Docker** o con **systemd/binario**?
Cambia 3 cosas (nombres de target, lectura de secrets y comando de reload).
Las dos variantes están marcadas en cada paso.

---

## 1. Traer los configs al VPS

`observability/` vive en GitLab (fuente de verdad):

```bash
ssh usuario@tu-vps
git clone https://gitlab.com/indexerdevops/indexerdevops.git
cd indexerdevops/observability
```

## 2. Crear los secrets (en el VPS)

```bash
sudo mkdir -p /etc/prometheus/secrets

# Token del backend (genera y GUÁRDALO; va también en el backend, Paso 6):
openssl rand -hex 32 | sudo tee /etc/prometheus/secrets/indexer_metrics_token

# Service role key de Supabase (pega el JWT, SIN salto de línea):
printf '%s' 'eyJhbGciOi...tu-service-role...' | sudo tee /etc/prometheus/secrets/supabase_service_role

sudo chmod 600 /etc/prometheus/secrets/*
sudo chown -R prometheus:prometheus /etc/prometheus/secrets 2>/dev/null || true
```

> Cada archivo debe tener **una sola línea sin salto final**. Por eso `printf` y no `echo`.

## 3. Levantar los exporters que faltan (host + frontend)

Recolectan la data del **VPS** (node_exporter `:9100`) y del **frontend**
(blackbox `:9115`).

**Con Docker** (reutiliza el compose solo para esos dos servicios; NO levanta otro
Prometheus/Grafana):

```bash
cd ~/indexerdevops/observability
docker compose up -d node-exporter blackbox-exporter
docker ps | grep -E 'node-exporter|blackbox'   # ambos deben estar Up
```

**Con systemd/binario:** instala `node_exporter` (`:9100`) y `blackbox_exporter`
(`:9115`), este último con `--config.file=.../observability/blackbox/blackbox.yml`.

## 4. Añadir los jobs a tu `prometheus.yml` existente

Edita tu `prometheus.yml` (típico `/etc/prometheus/prometheus.yml`) y añade dentro
de `scrape_configs:` estos 4 bloques. **Rellena los placeholders** y ajusta
`TARGET_NODE` / `TARGET_BLACKBOX` según la tabla de más abajo.

```yaml
  - job_name: node
    static_configs:
      - targets: ["TARGET_NODE:9100"]
        labels: { host: vps-1 }

  - job_name: indexer-backend
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/indexer_metrics_token
    static_configs:
      - targets: ["api.tudominio.com"]   # ← tu host de backend (443 implícito)

  - job_name: blackbox-http
    metrics_path: /probe
    params: { module: [http_2xx] }
    static_configs:
      - targets:
          - https://tu-usuario.github.io/tu-repo/         # ← tus URLs reales
          - https://tu-usuario.github.io/tu-repo/authors
    relabel_configs:
      - { source_labels: [__address__], target_label: __param_target }
      - { source_labels: [__param_target], target_label: instance }
      - { target_label: __address__, replacement: TARGET_BLACKBOX:9115 }

  - job_name: supabase
    scheme: https
    metrics_path: /customer/v1/privileged/metrics
    scrape_interval: 60s
    basic_auth:
      username: service_role
      password_file: /etc/prometheus/secrets/supabase_service_role
    static_configs:
      - targets: ["TU_PROJECT_REF.supabase.co"]
```

| Tu Prometheus corre como… | `TARGET_NODE` | `TARGET_BLACKBOX` | secrets |
|---|---|---|---|
| **systemd / binario (host)** | `localhost` | `localhost` | se leen directo de `/etc/prometheus/secrets/` |
| **Docker** (misma red que los exporters) | `node-exporter` | `blackbox-exporter` | monta `/etc/prometheus/secrets:ro` en el contenedor de Prometheus |

## 5. Reglas de alerta (recomendado)

```bash
sudo mkdir -p /etc/prometheus/rules
sudo cp ~/indexerdevops/observability/prometheus/rules/alerts.yml /etc/prometheus/rules/
```

Y en `prometheus.yml`:

```yaml
rule_files:
  - /etc/prometheus/rules/*.yml
```

## 6. Configurar el backend (en su host, no el VPS)

En el `.env` del backend pon el **mismo** token del Paso 2 y reinícialo:

```
METRICS_TOKEN=<contenido de /etc/prometheus/secrets/indexer_metrics_token>
```

Asegúrate de que `/metrics` sea accesible por **HTTPS** (detrás de Nginx/Caddy, 443).

## 7. Red / firewall

- **VPS → internet (saliente 443):** para alcanzar backend y Supabase (suele estar abierto).
- **node_exporter / blackbox:** locales al VPS; no exponerlos a internet.
- **Backend:** `/metrics` alcanzable públicamente por HTTPS (el token lo protege).

## 8. Recargar Prometheus y verificar targets

```bash
# systemd:
promtool check config /etc/prometheus/prometheus.yml
sudo systemctl reload prometheus            # o: sudo kill -HUP $(pidof prometheus)

# Docker:
docker exec CONTENEDOR_PROM promtool check config /etc/prometheus/prometheus.yml
docker kill -s SIGHUP CONTENEDOR_PROM       # o: curl -X POST http://localhost:9090/-/reload
```

Abre **`http://tu-vps:9090` → Status → Targets**: `node`, `indexer-backend`,
`blackbox-http` y `supabase` deben estar **UP**.

## 9. Verificar la data y dashboards

```bash
# Backend (debe responder métricas):
curl -H "Authorization: Bearer $(sudo cat /etc/prometheus/secrets/indexer_metrics_token)" \
  https://api.tudominio.com/metrics | head

# Supabase:
curl -u "service_role:$(sudo cat /etc/prometheus/secrets/supabase_service_role)" \
  https://TU_PROJECT_REF.supabase.co/customer/v1/privileged/metrics | head
```

En Grafana → Dashboards → Import → sube los JSON de
`observability/grafana/provisioning/dashboards/` apuntando al datasource Prometheus.

---

## Troubleshooting (target en DOWN)

| Síntoma | Causa probable |
|---|---|
| `indexer-backend` DOWN / 401 | token del backend ≠ `indexer_metrics_token`, o `/metrics` no expuesto por HTTPS |
| `supabase` DOWN | `PROJECT_REF` mal escrito o `service_role` inválido/con salto de línea |
| `node` / `blackbox-http` DOWN | `TARGET_NODE`/`TARGET_BLACKBOX` con el nombre equivocado para tu modo (host vs Docker), o exporter no levantado |
| Docker: secrets "no such file" | falta montar `/etc/prometheus/secrets` en el contenedor de Prometheus |

Comprobación manual de una sonda del frontend:

```bash
curl "http://localhost:9115/probe?module=http_2xx&target=https://tu-usuario.github.io/tu-repo/" \
  | grep -E "probe_success|probe_http_status_code"
```
