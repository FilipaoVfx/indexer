# Secrets for Prometheus scraping

These files are mounted read-only into Prometheus at `/etc/prometheus/secrets/`.
They are **gitignored** — never commit real values. Create them on the VPS only.

Each file must contain a single line with **no trailing newline**. Create them
with `printf` (not `echo`, which appends a newline):

## `indexer_metrics_token`

The Bearer token guarding the backend `/metrics` endpoint. Must equal
`METRICS_TOKEN` in the backend environment.

```bash
# Generate once and use the same value on both sides:
TOKEN=$(openssl rand -hex 32)
printf '%s' "$TOKEN" > indexer_metrics_token
echo "Set METRICS_TOKEN=$TOKEN in the backend env too."
```

## `supabase_service_role`

The Supabase **service role key** (JWT), used as the HTTP Basic password
(username `service_role`) to scrape Supabase's privileged metrics endpoint.
Copy it from: Supabase Dashboard → Project Settings → API → `service_role`.

```bash
printf '%s' 'eyJhbGciOi...your-service-role-jwt...' > supabase_service_role
```

After changing a secret, reload Prometheus:

```bash
docker compose kill -s SIGHUP prometheus   # or: curl -X POST http://localhost:9090/-/reload
```
