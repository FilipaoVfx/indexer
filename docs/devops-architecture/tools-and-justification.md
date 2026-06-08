# Justificación de Herramientas — Indexer

## 1. Git

- **Propósito**: Control de versiones distribuido.
- **Función en el proyecto**: Gestión del historial de cambios en todos los componentes (backend, frontend, extensión, SQL).
- **Relación con DevOps**: Base fundamental para CI/CD; cada push dispara el pipeline automático.
- **Beneficios**: Trazabilidad completa, trabajo colaborativo con ramas, reversión de cambios.

## 2. GitLab

- **Propósito**: Plataforma de gestión de repositorios y colaboración.
- **Función en el proyecto**: Aloja el código fuente y gestiona el ciclo de vida del desarrollo.
- **Relación con DevOps**: Integra repositorio, CI/CD, gestión de artefactos y variables de entorno en una sola plataforma.
- **Beneficios**: Centralización del flujo de trabajo, visibilidad del estado del proyecto, gestión de permisos.

## 3. GitLab CI/CD

- **Propósito**: Automatización de integración y entrega continua.
- **Función en el proyecto**: Ejecuta pipeline con stages `validate` y `build`; valida backend (lint, typecheck, tests, migraciones SQL), extensión (syntax check, validación de manifest) y frontend (lint, typecheck, build).
- **Relación con DevOps**: Implementa los principios de CI/CD: cada cambio se valida automáticamente antes de integrarse.
- **Beneficios**: Detección temprana de errores, builds reproducibles, artefactos versionados con expiración.

## 4. Docker

- **Propósito**: Contenerización de aplicaciones.
- **Función en el proyecto**: El pipeline CI utiliza imágenes Docker (`node:20`, `mcr.microsoft.com/powershell:7.4-debian-12`) para ejecutar jobs en ambientes consistentes.
- **Relación con DevOps**: Garantiza que el código se ejecuta en el mismo entorno en desarrollo, CI y producción.
- **Beneficios**: Reproducibilidad, aislamiento de dependencias, portabilidad entre ambientes.

## 5. VPS (Virtual Private Server)

- **Propósito**: Infraestructura de despliegue.
- **Función en el proyecto**: Servidor donde se despliega el backend Node.js y el frontend estático.
- **Relación con DevOps**: Destino del despliegue continuo; recibe los artefactos generados por el pipeline.
- **Beneficios**: Control total sobre el ambiente de ejecución, costo predecible, flexibilidad de configuración.

## 6. Supabase (PostgreSQL)

- **Propósito**: Base de datos relacional con funcionalidades serverless.
- **Función en el proyecto**: Almacena bookmarks, perfiles de autores, READMEs de GitHub, clasificaciones de repos. Provee búsqueda vectorial y funciones SQL personalizadas.
- **Relación con DevOps**: Migraciones SQL versionadas (001–013) permiten evolucionar el schema de forma controlada y auditable.
- **Beneficios**: PostgreSQL administrado, APIs REST automáticas, RLS para seguridad, extensiones para búsqueda vectorial.

## 7. Pinecone

- **Propósito**: Base de datos vectorial especializada.
- **Función en el proyecto**: Almacena embeddings para búsqueda semántica de bookmarks y contenido.
- **Relación con DevOps**: Servicio externo integrado que complementa la búsqueda en Supabase.
- **Beneficios**: Búsqueda por similitud de alta performance, escalabilidad para millones de vectores.

## 8. OpenAI

- **Propósito**: Generación de embeddings y respuestas con IA.
- **Función en el proyecto**: Genera embeddings de texto para búsqueda semántica y clasificación de contenido.
- **Relación con DevOps**: API externa integrada al pipeline de procesamiento de datos.
- **Beneficios**: Embeddings de alta calidad, capacidad de clasificación, generación de texto.

## 9. n8n

- **Propósito**: Plataforma de automatización de flujos de trabajo.
- **Función en el proyecto**: Orquesta flujos ETL de ingesta de datos (YouTube, fuentes externas).
- **Relación con DevOps**: Automatiza procesos repetitivos de procesamiento de datos sin intervención manual.
- **Beneficios**: Automatización visual, integraciones pre-construidas, ejecución programada.

## 10. Prometheus

- **Propósito**: Sistema de monitoreo y recolección de métricas.
- **Función en el proyecto**: Recolecta métricas de performance y salud del backend y servicios.
- **Relación con DevOps**: Pilar de observabilidad; permite detectar problemas antes de que afecten al usuario.
- **Beneficios**: Modelo pull-based, lenguaje PromQL para consultas, alertas configurables.

## 11. Grafana

- **Propósito**: Plataforma de visualización y dashboards.
- **Función en el proyecto**: Presenta métricas de Prometheus en dashboards visuales para monitoreo operativo.
- **Relación con DevOps**: Cierra el ciclo de retroalimentación; permite al equipo observar el comportamiento del sistema en producción.
- **Beneficios**: Dashboards personalizables, alertas, integración nativa con Prometheus.
