# Robustecimiento de X Indexer 0.5.0

Implementación en la rama `codex/harden-extension-delivery`, sobre el código auditado `612e3930d7965c9fd50e66ad73d9cff6e2e4b497`. El diagnóstico original se conserva en `/root/audits/indexer-extension-20261002/diagnostico.md` del entorno de trabajo.

## Resultado

La extensión utiliza una única entrega persistente contra `/api/bookmarks/batch`, con merge PostgreSQL y confirmación de IDs. El popup inicia trabajos, y la pestaña de X observa páginas y conserva checkpoints; cada trabajo fija su selección antes de enviar. Las capturas más completas se conservan incluso cuando llegan durante un envío o después de un commit cuya respuesta se perdió.

Los errores de esquema y de red quedan visibles. La cobertura completa requiere evidencia terminal y ausencia de gaps; una página posterior sana no borra la evidencia de pérdida anterior. El backend conserva texto, enlaces, media, autor y fechas al combinar capturas. La expansión diferida y las autorrespuestas también unen arrays de forma atómica.

## Correspondencia con el diagnóstico

| Hallazgo | Corrección | Verificación |
|---|---|---|
| F01: autores y citas como bookmarks | Pertenencia explícita al timeline y tipo Tweet | Fixtures GraphQL con User, cita, wrapper y módulo |
| F02: carga inicial concurrente pierde cola | Single-flight de carga y journal serial | 25 enqueues concurrentes y reinicio |
| F03: popup corta importación | Trabajo persistido, ACK inmediato y selección fija | Chromium real: cerrar popup y confirmar captura |
| F04: DLQ no atómica/poda de 50 | Una transición persistida, payloads rechazados conservados | Outage con 55 capturas; fallo de storage en transición |
| F05: captura pobre sobreescribe datos | RPC monotónico y append atómico | PostgreSQL local: riqueza, fechas, arrays y concurrencia |
| F06: falsa finalización tras 700 ms | Espera de red y cobertura completa/parcial/rango | Quiet DOM, terminal, esquema y gap acumulado |
| F07: error sobrescrito por ok:true | Error final después del status | Inicialización fuera de bookmarks y errores UI |
| F08: HTTP 200 confirma inválidos | ACK por ID y rechazo conservado | Respuesta parcial, IDs ausentes y rutas HTTP reales |
| F09: truncamiento, párrafos y URLs inventadas | 12 000 caracteres y flag; red mejora DOM; conservar href | Note tweet, newlines, late upgrade y elipsis |
| F10: unknown y descartes no recuperables | Reclasificar y persistir descarte de drafts | Recuperación IDs y reset network-only |
| F11: respuestas ajenas/recomendaciones | Mismo autor y parent ID de red verificado | Rechazo de autor ajeno aun con cue |
| F12: nodo virtualizado cambia ID | Snapshot inicial y revalidación | Reciclaje de nodo no encola otro tweet |
| F13: clic sin guardado real en X | Esperar removeBookmark | Sin confirmación no se encola |
| F14: dedupe bloquea reintento fallido | Reservar en vuelo; registrar tras aceptación | Enqueue rechazado admite nuevo intento |
| F15: ajustes redirigen capturas | Binding congelado y namespace JSON | Cambio de backend/usuario y usuario con separador |
| F16: timeout termina en headers | Deadline incluye parseo del cuerpo | Cuerpo colgado que ignora abort |
| F17: candidatos antiguos quedan hambrientos | Cursor, desempate por ID y pendientes de página | Migración legacy y avance después de página agotada |
| F18: se pierde procedencia network | Metadatos conservados extremo a extremo | Restart de draft con capture/entity_type |

Dos revisiones internas independientes dentro del mismo entorno terminaron sin hallazgos pendientes en el alcance. La revisión adicional por Claude Code recibió el código fuente, pero agotó su límite de 240 segundos y no produjo un diagnóstico; esa cobertura externa no se considera completada.

La revisión adversarial interna encontró y corrigió además: rango desplazado al reanudar; ACK que eliminaba una mejora concurrente; migración cerca de cuota; trimming legacy que borraba el cursor; lectura posterior al commit que perdía el snapshot del enriquecimiento; Tweet inválido que parecía esquema sano; página sana que ocultaba un gap; descarte que anunciaba éxito tras fallo; y retry insert-only después de un commit incierto.

## Pruebas reproducibles

Node 24, `npm ci --ignore-scripts`:

- `npm run check:extension`: sintaxis de cinco scripts y consistencia del manifest.
- `npm test`: 49 pruebas, 49 aprobadas. Incluye 19 de captura, 22 de entrega y 8 de backend/SQL/HTTP. PGlite ejecuta PostgreSQL local y la migración real, sin credenciales ni datos de producción.
- `npm run test:browser`: una prueba adicional aprobada en Chromium con la extensión MV3 instalada, un perfil temporal, X simulado y backend local. Verifica el puente MAIN, entrega network, cierre del popup y confirmación del job.
- `git diff --check`: aprobado.

El paquete local verificado es `dist/x-bookmarks-extension-0.5.0.zip`, con ocho archivos de la extensión.

La nueva CI `.github/workflows/extension-regression.yml` ejecuta estas verificaciones en PRs y cambios de ingesta. La CI remota todavía no se ha ejecutado: estos resultados corresponden al entorno local.

## Activación y límites

1. Aplicar [migración 017](../backend/sql/017_preserve_bookmark_capture.sql) en Supabase.
2. Desplegar backend actualizado con `SUPABASE_SERVICE_ROLE_KEY` y `API_KEY` configuradas.
3. Cargar/recargar la extensión y después recargar X. Las instrucciones están en [extension/README.md](../extension/README.md).
4. Validar con una sesión real de X: texto largo, carga lenta, cerrar popup, reiniciar Chrome, caída/429 del backend y cambio de cuenta.

No se aplicaron migraciones ni se publicó el backend en producción. No hay una sesión autenticada de X validada en este entorno. Los fixtures y Chromium comprueban el comportamiento ante contratos representativos; no certifican que el esquema vigente o cada variante de X coincida con esos fixtures.

Cambiar cuenta en X mediante SPA sigue requiriendo validación y aislamiento por viewer; el usuario configurado de Indexer es el destino de datos. Iniciar una pestaña/recorrido nuevo para cambiar de cuenta. Cerrar la pestaña puede interrumpir el escaneo; solo los checkpoints ya aceptados están garantizados. El enriquecimiento de repos/contextos permanece asíncrono en el backend y no tiene outbox durable en esta versión.

El merge conserva el texto más largo; no representa ediciones o eliminaciones de X como un espejo exacto. Se prioriza conservar conocimiento capturado. Los recibos idempotentes conservan las últimas 1000 solicitudes; una repetición más antigua puede volver a entregarse, pero el merge por ID protege el contenido.
