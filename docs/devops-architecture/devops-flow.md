# Flujo DevOps — Indexer

## Ciclo Completo

El flujo DevOps de Indexer implementa un ciclo continuo desde el desarrollo hasta la retroalimentación, alineado con los principios de integración y entrega continua.

---

## 1. Desarrollo

- El desarrollador trabaja en una rama de feature (`feature/`, `fix/`, `docs/`).
- Utiliza entorno local con Node.js 20 y variables de entorno configuradas via `.env`.
- El backend se ejecuta con `npm run dev` (watch mode) en puerto 8787.
- El frontend se levanta con `astro dev`.

**Principio DevOps**: Ambientes de desarrollo aislados que replican producción.

---

## 2. Commit

- Se realizan commits atómicos con cambios lógicamente relacionados.
- El proyecto gestiona tres componentes independientes: backend, web-astro, extension.
- Las migraciones SQL siguen convención numérica estricta (001_, 002_, ...).

**Principio DevOps**: Commits pequeños y frecuentes reducen riesgo de integración.

---

## 3. Push

- El código se sube a GitLab en la rama correspondiente.
- El push dispara automáticamente el pipeline CI/CD definido en `.gitlab-ci.yml`.

**Principio DevOps**: Automatización mediante eventos; no hay intervención manual para iniciar validación.

---

## 4. Pipeline CI (Integración Continua)

El pipeline se ejecuta en contenedores Docker y consta de dos stages:

### Stage: validate

Ejecuta en paralelo:

- **validate_backend**: `npm ci` → lint → typecheck → test → syntax check de archivos JS → validación de orden y contenido de migraciones SQL.
- **validate_extension**: syntax check de archivos JS → validación del manifest.json (MV3, referencias de archivos existentes).

### Stage: build

Ejecuta en paralelo:

- **build_web**: `npm ci` → lint → typecheck → `astro build` → genera artefacto `web-astro/dist/`.
- **package_extension**: empaqueta extensión en `x-bookmarks-extension.zip`.

**Principio DevOps**: Feedback rápido; errores se detectan en minutos, no en producción.

---

## 5. Build Docker

- Los jobs del pipeline se ejecutan sobre imágenes Docker: `node:20` y `mcr.microsoft.com/powershell:7.4-debian-12`.
- El cache de npm se almacena en `$CI_PROJECT_DIR/.npm` para acelerar builds.
- Los artefactos generados tienen expiración de 1 semana.

**Principio DevOps**: Builds reproducibles y determinísticos mediante contenerización.

---

## 6. Despliegue

- Los artefactos validados se despliegan al VPS.
- El frontend estático (`web-astro/dist/`) se sirve directamente.
- El backend Node.js se ejecuta como servicio persistente.

**Principio DevOps**: Entrega continua; artefactos probados llegan a producción sin reconfiguración manual.

---

## 7. Ejecución

- Backend: API REST en Node.js sirviendo endpoints de búsqueda, ingesta y clasificación.
- Frontend: Dashboard Astro + React con búsqueda semántica, visualización de repos y autores.
- Extensión: Scraping de bookmarks en X/Twitter e ingesta por lotes al backend.
- n8n: Flujos ETL automáticos para ingesta de fuentes externas.

**Principio DevOps**: Servicios desacoplados que pueden escalar y actualizarse independientemente.

---

## 8. Monitoreo

- Prometheus recolecta métricas de performance, latencia y errores del backend.
- Grafana presenta dashboards en tiempo real para observar el comportamiento del sistema.
- Alertas configurables notifican ante degradación del servicio.

**Principio DevOps**: Observabilidad permite detectar y resolver problemas proactivamente.

---

## 9. Retroalimentación

- Métricas de Grafana informan decisiones de optimización.
- Errores detectados generan nuevos issues y se incorporan al backlog.
- El ciclo se reinicia: desarrollo → commit → push → validación → despliegue.

**Principio DevOps**: Mejora continua basada en datos reales de producción.
