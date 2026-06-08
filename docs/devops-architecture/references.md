# Referencias — Arquitectura DevOps Indexer

## Formato APA 7

Kim, G., Humble, J., Debois, P., & Willis, J. (2016). *The DevOps Handbook: How to Create World-Class Agility, Reliability, & Security in Technology Organizations*. IT Revolution Press.

Lwakatare, L. E., Kuvaja, P., & Oivo, M. (2016). Relationship of DevOps to Agile, Lean and Continuous Deployment. En P. Abrahamsson et al. (Eds.), *Product-Focused Software Process Improvement* (pp. 399–415). Springer. https://doi.org/10.1007/978-3-319-49094-6_27

Turnbull, J. (2014). *The Docker Book: Containerization Is the New Virtualization*. James Turnbull.

## Aplicación de Referencias en el Proyecto

| Concepto | Referencia | Aplicación en Indexer |
|---|---|---|
| Pipeline CI/CD | Kim et al. (2016) | GitLab CI con stages validate y build automatizados |
| Contenerización | Turnbull (2014) | Jobs CI ejecutados en contenedores Docker (node:20) |
| Integración Continua | Lwakatare et al. (2016) | Validación automática en cada push: lint, tests, migrations |
| Entrega Continua | Kim et al. (2016) | Artefactos generados y versionados para despliegue |
| Observabilidad | Kim et al. (2016) | Prometheus + Grafana para monitoreo de producción |
| Automatización | Lwakatare et al. (2016) | n8n para flujos ETL, CI/CD para validación de código |
