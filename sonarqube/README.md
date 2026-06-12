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

## Integración CI (GitLab)

En `.ci-jobs.yml` (etapa `validate`) hay **dos jobs** ya listos. Elige uno según dónde
corra SonarQube definiendo la variable que lo activa en
**Settings → CI/CD → Variables** (protegidas y enmascaradas). El otro job se omite solo.

### Variante A — SonarQube self-hosted (`sonarqube-check`)

Para un servidor SonarQube propio accesible desde los runners.

| Variable | Valor |
| --- | --- |
| `SONAR_HOST_URL` | URL del servidor (ej. `https://sonar.tudominio.com`) |
| `SONAR_TOKEN` | token de análisis de SonarQube |

> El SonarQube local en Docker (`http://localhost:9000`) **no** es accesible desde
> los runners de GitLab.com; necesitas exponerlo en red.

### Variante B — SonarCloud (`sonarcloud-check`)

[SonarCloud](https://sonarcloud.io) es el SaaS de SonarSource (gratis para repos
públicos). No hostea nada tú.

| Variable | Valor |
| --- | --- |
| `SONAR_ORGANIZATION` | clave de tu organización en SonarCloud |
| `SONAR_TOKEN` | token generado en SonarCloud (*My Account → Security*) |
| `SONAR_PROJECT_KEY` | *(opcional)* clave del proyecto en SonarCloud, normalmente `<org>_<repo>` |

Pasos:
1. Crea cuenta en https://sonarcloud.io e importa el repo (o crea la organización + proyecto).
2. Copia la **Organization Key** y la **Project Key** que te muestra SonarCloud.
3. Genera un token y define las variables de arriba en GitLab.

El job pasa `-Dsonar.host.url=https://sonarcloud.io` y `-Dsonar.organization` por línea
de comandos, así que **no** necesitas tocar `sonar-project.properties` para el CI.

### Correr SonarCloud en local

```powershell
docker run --rm `
  -e SONAR_TOKEN="tu_token" `
  -v "${PWD}:/usr/src" `
  sonarsource/sonar-scanner-cli `
  -Dsonar.host.url=https://sonarcloud.io `
  -Dsonar.organization=tu-organizacion
```
