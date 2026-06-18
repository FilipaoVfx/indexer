# Análisis de código con SonarQube (Docker)

Stack para analizar el monorepo **x-bookmarks-indexer** (backend Node.js, web-astro,
extension) con SonarQube Community Edition corriendo en Docker. No necesitas instalar
nada local: tanto el servidor como el scanner van en contenedores.

## Componentes

| Archivo | Qué hace |
| --- | --- |
| `sonarqube/docker-compose.yml` | Servidor SonarQube + PostgreSQL + servicio `scanner` (bajo profile `scan`) |
| `sonar-project.properties` | Configuración del análisis (clave del proyecto, sources, exclusiones) |
| `scripts/sonar-scan.ps1` | Helper de PowerShell para lanzar el scanner |

## Requisitos

- Docker Desktop corriendo.
- ~2-3 GB de RAM libres para el contenedor de SonarQube (lleva Elasticsearch embebido).

> **Windows / WSL2:** si SonarQube no arranca y en sus logs ves
> `max virtual memory areas vm.max_map_count [65530] is too low`, ejecuta en una
> terminal WSL: `sudo sysctl -w vm.max_map_count=262144` (o ponlo en `/etc/sysctl.conf`).

## Pasos

Todos los comandos se ejecutan desde la raíz del repo (`indexer/`).

### 1. Levantar el servidor

```powershell
docker compose -f sonarqube/docker-compose.yml up -d sonarqube
```

La primera vez tarda ~1-2 min en inicializar. Comprueba el estado con:

```powershell
docker compose -f sonarqube/docker-compose.yml logs -f sonarqube
```

Cuando veas `SonarQube is operational`, abre **http://localhost:9000**.

### 2. Login y token

1. Entra con `admin` / `admin` y cambia la contraseña cuando lo pida.
2. Ve a **My Account → Security → Generate Tokens**.
3. Genera un token (tipo *Global Analysis Token* o *Project Analysis Token*) y cópialo.

### 3. Lanzar el análisis

**Opción A — script de PowerShell (recomendado):**

```powershell
./scripts/sonar-scan.ps1 -Token "squ_tu_token_aqui"
```

**Opción B — docker compose con el profile `scan`:**

```powershell
$env:SONAR_TOKEN = "squ_tu_token_aqui"
docker compose -f sonarqube/docker-compose.yml --profile scan run --rm scanner
```

Al terminar, los resultados quedan en **http://localhost:9000** dentro del proyecto
`X Bookmarks Indexer`.

## Operación

```powershell
# Parar el servidor (conserva los datos en los volúmenes)
docker compose -f sonarqube/docker-compose.yml down

# Borrar TODO, incluida la base de datos y el histórico de análisis
docker compose -f sonarqube/docker-compose.yml down -v
```

## Ajustar qué se analiza

Edita `sonar-project.properties` en la raíz. Actualmente se analiza todo el repo
excluyendo `node_modules`, `dist`, `.astro`, lock files, etc. Cuando agregues tests
con cobertura, descomenta las líneas `sonar.tests` y `sonar.javascript.lcov.reportPaths`.

## Integración CI (GitLab → SonarCloud)

El CI usa **SonarCloud** mediante el job `sonarcloud-check` en `.ci-jobs.yml`
(etapa `validate`). Los identificadores **públicos** ya están fijos en
`sonar-project.properties`:

- `sonar.organization=indexerdevops`
- `sonar.projectKey=indexerdevops_indexerdevops`

Lo **único** que defines en GitLab (**Settings → CI/CD → Variables**) es el secreto:

| Variable | Valor | Flags |
| --- | --- | --- |
| `SONAR_TOKEN` | token generado en SonarCloud (*My Account → Security*) | **Masked** + **Protected** |

El job se **omite** si `SONAR_TOKEN` no está definido (no rompe el pipeline).

### Antes de la primera corrida

1. En SonarCloud, en el proyecto `indexerdevops_indexerdevops`:
   **Administration → Analysis Method → desactiva "Automatic Analysis"**
   (si no, rechaza el análisis del CI con *"you are running CI analysis while
   Automatic Analysis is enabled"*).
2. Genera el `SONAR_TOKEN` y guárdalo como variable en GitLab.
3. Lanza el pipeline: **CI/CD → Pipelines → Run pipeline** (rama `main`).

### Correr SonarCloud en local

```powershell
docker run --rm `
  -e SONAR_TOKEN="tu_token" `
  -v "${PWD}:/usr/src" `
  sonarsource/sonar-scanner-cli `
  -Dsonar.host.url=https://sonarcloud.io
```

> La `organization` y la `projectKey` salen del `sonar-project.properties`, así que
> no hace falta pasarlas por línea de comandos.
