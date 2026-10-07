# Validación del robustecimiento de Indexer

**Fecha:** 7 de octubre de 2026. **Estado:** especificación de pruebas; no representa resultados ejecutados. Complementa el [plan de implementación](./indexer-robustecimiento.md). Cada paquete debe adjuntar resultados reales antes de cerrar su puerta.

## 1. Entornos y evidencia

| Entorno | Uso | Restricciones |
|---|---|---|
| Unitario/fixtures | Selección de contenido, parser, DTO, retry y cursors | Datos sintéticos o anonimizados; sin proveedores facturables |
| PostgreSQL 17 aislado | Triggers, RPC, índices, locks, leases y rollback | Misma familia de versión de producción; dos conexiones reales para concurrencia |
| Staging integrado | API, worker, web, extensión y fallos de proceso/proveedor | DB/namespace y credenciales separados; limpieza mediante jobs |
| Producción canary | Contrato de release, una captura marcada, cobertura y lecturas | Corpus autorizado, presupuesto explícito; sin matar procesos ni inducir pérdida de datos reales |
| Producción observada | Latencia, disponibilidad, lag y drift después de release | Observación sin carga agresiva; incidentes conservan logs/trace |

PGlite es útil para lógica SQL, pero no certifica locks entre procesos, `SKIP LOCKED`, creación concurrente de índices ni planes idénticos a Supabase. El suite de concurrencia y los benchmarks usan PostgreSQL real. Las pruebas existentes de extensión se conservan, pero no sustituyen estas comprobaciones del producto.

Estructura propuesta de evidencia por release: `commit`, esquema/fingerprint, entorno, versión de Node/PostgreSQL, configuración sin secretos, dataset/hash, hora UTC, comandos, resultados, trazas y limitaciones. Evidencia local fuera del repo: `/root/audits/indexer-hardening/<release>/`; esta ruta se creará al ejecutar, no se da por existente. Los fixtures persistidos en Git deben estar anonimizados y no incluir el PAT, service-role, cookies, texto privado o URLs de acceso firmado.

## 2. Dataset de regresión

Preparar fixtures independientes de las implementaciones bajo prueba:

- Dos corpus disjuntos, un principal autorizado a uno y un servicio con scope específico. Incluir selección rápida entre corpus.
- Post con texto limpio largo, captura parcial más corta, captura contaminada más larga y corrección limpia verificable. Distinguir multimedia sin texto de captura inválida.
- Post Tabularis sin relación con FlyAI; README FlyAI globalmente relevante y otro README efectivamente vinculado. Comprobar identidad y razón de asociación.
- URLs GitHub simples, `.git`, fragmento/query, comentarios, cierre `)`, espacios, casing, usuarios sin repo y rutas GitHub que no son repositorios. `blob:`, URL inválida y medios durables.
- Fuente en revisión A con un repo/contexto; revisión B con dos; terminar tareas B/A en orden inverso. Corrección que retira un enlace de forma explícita.
- Más de 100 coincidencias, fechas iguales y faltantes, autor desconocido, medios/enlaces fuera de la primera página y repo compartido entre corpus.
- Más de 2.000 bookmarks y 500 READMEs; páginas de servicio menores que el tamaño solicitado. Última página incompleta y corpus vacío.
- README bueno seguido de 404, 429, timeout y 5xx; clasificación v1/v3 repetida y contenido cambiado mientras clasifica.
- Fuente vectorial de tres chunks que pasa a uno, modelo/chunker cambiado, upsert parcial, estado DB fallido y fuente borrada con limpieza externa demorada.
- Corpus de 10.000 fuentes con distribución realista de tamaños/autores/repos y muchos posts del mismo dominio. No limitar la prueba a filas cortas todas iguales.

Las respuestas esperadas se anotan por identidad/conjunto/procedencia, no copiando la función que se quiere validar. No escribir snapshots de scores que conviertan una heurística accidental en contrato.

## 3. Matriz funcional y de fallos

Cada caso indica una propiedad observable. Los IDs Txx sirven para asociar resultados a PRs. Las pruebas de caída y rollback se ejecutan en staging/DB aislada.

| Caso | Paquetes | Estímulo | Resultado exigido |
|---|---|---|---|
| T01 | P00 | Esquema sin RPC 017; iniciar versión que las necesita | Preflight explica capacidades faltantes; ingesta no confirma una escritura inválida |
| T02 | P00, P09 | Aplicar migración, repetirla y alterar checksum | Una aplicación registrada; repetición segura; discrepancia bloqueada con diagnóstico |
| T03 | P01 | `old` lenta, `new` rápida, resolución inversa | URL/input/tarjetas/loading/error pertenecen a `new` |
| T04 | P01, P07 | Cambiar corpus mientras autores/repos/objetivo responden | Nunca publicar ni cachear como vigentes los datos de otro corpus |
| T05 | P01 | API no responde, health más lento que su intervalo | Estado comprensible dentro de 12 s y un solo sondeo en vuelo |
| T06 | P01 | 400/401/403/404, 429 con Retry-After, 5xx y cancelación | Cero retry en 4xx permanentes; retry elegible dentro del presupuesto; cancelación silenciosa |
| T07 | P01, P04 | Objetivo encuentra README sin FK al post | Post mantiene ID/título/URL propios; repo global separado como sugerencia |
| T08 | P01 | Score 0, estrellas ausentes, ruta con 3/3 pasos | Sin confianza inventada; sin estrellas fabricadas; cobertura 100 % |
| T09 | P02 | Error al crear outbox dentro del commit de captura | Rollback de captura y job; ningún ID falsamente confirmado |
| T10 | P02 | Mismo lote reenviado varias veces y captura con arrays enriquecidos | ACK estable por ID; un trabajo por revisión/fase; no pierde enlaces válidos |
| T11 | P02 | Texto más largo contaminado frente a limpio; multimedia vacía | Selección por evidencia/calidad; original conservado; multimedia no se borra por vacío |
| T12 | P02, P03 | Escritura por importador/API/writer compatible | Mismos invariantes de revisión/outbox; fuente del writer trazable |
| T13 | P02, P07 | Cambio de visor/cuenta X durante captura pendiente | Job ligado a identidad/archivo inicial; pausa y revalidación antes de continuar |
| T14 | P03 | Crash tras commit/claim, antes o después de publicar derivados | Reinicio recupera tarea; resultados correctos y sin efectos duplicados |
| T15 | P03 | Dos workers, lease caducado, worker antiguo vuelve | Solo el token vigente publica; otro worker retoma sin pérdida |
| T16 | P03 | A/B calculados simultáneamente; B termina primero | Estado final B; A queda superseded y no borra enlaces/contextos nuevos |
| T17 | P03 | Error después de borrar relaciones dentro de RPC | Transacción revierte; conjunto publicado anterior intacto |
| T18 | P03 | Parser ejecutado con URLs de fixture en JS y PostgreSQL | Conjuntos correctos y concordantes; sin slug inventado ni pérdida por escaping |
| T19 | P03 | Relación con bookmark válido y propietario distinto | Rechazo por constraint/contrato; no cambia propietario para aceptar |
| T20 | P03 | Lote de 10 en corpus de 10.000 del mismo dominio | Procesa deltas; no reconstruye todo ni crea clique; vecinos acotados |
| T21 | P04 | 1.000 matches, página 50 y página vacía | Total 1.000, página ≤50, fin correcto; total no desaparece en página vacía |
| T22 | P04 | Filtros medios/enlaces/fecha/autor y orden reciente | DB filtra antes de paginar; encuentra registros fuera de primera página; empates estables |
| T23 | P04 | Cursor de otra query/corpus, expirado o modificado | Rechazo claro; reinicio de búsqueda; no fuga ni mezcla de páginas |
| T24 | P04 | Escribir entre páginas de búsqueda/browse | Snapshot rankeado estable; browse cumple marca de agua y semántica declarada |
| T25 | P04 | Consulta amplia supera presupuesto/candidatos | Resultado parcial identificado; no total exacto ficticio ni silencio sobre el límite |
| T26 | P04 | Stats, autores y repos de A/B; error DB | Scope coherente, definición única de desconocido; error no se convierte en cero |
| T27 | P04, P06 | Corpus supera caps; servicio recorta cada página | Recorre hasta fin mediante cursor; sin saltos/ciclos; checkpoint reanuda |
| T28 | P05 | README válido y después timeout/404/5xx | Conserva último contenido bueno y registra error/frescura aparte |
| T29 | P05 | 20 GET concurrentes y 20 refresh equivalentes | GET no llama proveedores/escribe; refresh tiene un job activo, no 20 |
| T30 | P05 | Clasificación v3 idéntica dos veces; fallo intermedio; README cambia | Sin duplicados; rollback atómico; resultado antiguo no publica sobre contenido nuevo |
| T31 | P06 | Pinecone rechaza upsert o solo acepta parte del lote | Generación no activa; retry completa; ningún chunk fallido queda committed |
| T32 | P06 | Upsert exitoso y después caída DB/reinicio | Reconciliación verifica IDs, recupera estado y promoción; no omite por hash local |
| T33 | P06 | IDs todavía no visibles tras ACK y lease expira | Estado pendiente/verification retry; solo lease vigente promueve tras comprobación |
| T34 | P06 | Fuente 3 → 1; cambiar chunker/modelo/dimensión | Nueva generación válida, old chunks retirados; incompatibilidad falla en preflight |
| T35 | P06, P07 | Borrar/retirar permiso mientras Pinecone delete falla | Fuente desaparece de resultados inmediatamente; cleanup durable conserva IDs |
| T36 | P06, P07 | Vector de fuente ajena/inexistente/inactiva/contaminada y varios chunks del mismo recurso | Filtrado autorizado con DB actual; corrección de contaminación invalida la generación anterior; dedupe por fuente; parcial si faltan resultados |
| T37 | P07 | Leer/escribir B como A por endpoint, cuerpo, cursor o job | Denegado en todas las rutas; service-role no evita resolver scope |
| T38 | P08 | Dry-run, reparación, interrupción y reejecución | Diff revisable, checkpoint útil y segunda ejecución sin cambios redundantes |
| T39 | P08 | Fuente editada después del dry-run; rollback con edición posterior | CAS evita overwrite; conflicto explícito y reevaluación |
| T40 | P08 | Reparar los seis corpus y comparar sets/revisiones | Cobertura completa o exclusión explicada, sin drift ni cambio silencioso de identidad |
| T41 | P09 | Scheduler/worker detenidos y fase RAG fallida | Heartbeat/alerta prueban fallo; no se presenta workflow íntegro como exitoso |
| T42 | P09 | Clone limpio y runbook seguido en sesión nueva | Demo útil y deploy staging reproducibles; sin comandos inexistentes ni secrets faltantes opacos |

## 4. Benchmark de latencia y crecimiento

### 4.1 Consultas y semántica

Preparar al menos 30 consultas anotadas: texto exacto, camelCase, prefijo, error tipográfico, español/inglés, URL/repo, autor, dominio, inexistente, amplia, filtros combinados y browse. Incluir `react` y el objetivo de RAG/PostgreSQL de la auditoría. Para cada una definir fuentes relevantes, falsos positivos prohibidos, scope y motivo de asociación.

La eliminación de CSS puede reducir los 39 matches originales de `react`; no conservar ese número como verdad. El buscador nuevo puede cambiar ranking fuzzy, pero debe documentar los cambios y mantener recuperación de las fuentes relevantes anotadas. Exigir cero identidades ajenas y cero matches derivados solo de contaminación en los fixtures; comparar Precision@10/Recall@20 sobre los casos anotados y explicar cualquier pérdida antes de activar.

### 4.2 Protocolo

1. Fijar commit/esquema, volumen, región y recursos. No variar instancias y queries a la vez durante comparación causal.
2. Dos datasets: snapshot reparado de referencia y sintético de 10.000. Medir cada corpus y alcance autorizado agregado; no benchmarkear solo el más pequeño.
3. Warm-up de diez peticiones por operación. Después obtener al menos 100 muestras por clase, conservando fallos/timeouts, bajo concurrencia 1 y 5. Registrar carga concurrente de ingesta/worker.
4. Separar tiempo SQL, DB/red, API y navegación. Obtener `EXPLAIN (ANALYZE, BUFFERS)` representativo fuera de la carga principal; no usar la instrumentación de EXPLAIN como reloj de cada request.
5. Medir búsqueda, browse, repos, autores, stats, objetivo y ACK de lote de diez. Medir tiempo hasta primera respuesta relevante en navegador desde Bogotá cuando sea posible; declarar ubicación/proxy del agente si es distinta.
6. Medir arranque por separado con diez ciclos controlados en staging y navegación sin cache caliente. Correlacionar inicio de proceso, primera conexión DB y disponibilidad; no etiquetar toda espera como cold start.
7. Calcular p50/p95, errores y bytes retornados. Conservar valores brutos; comparación antes/después usa la misma batería y condiciones.

### 4.3 Presupuestos de aceptación

| Operación | Corpus actual, backend caliente | Corpus de 10.000 |
|---|---|---|
| Búsqueda completa representativa | SQL p95 ≤300 ms; API p95 ≤1 s | API p95 objetivo ≤1,5 s; si falla, investigar plan/límites antes de habilitar crecimiento |
| Browse | SQL p95 ≤150 ms; API p95 ≤700 ms | API p95 objetivo ≤1 s con mismo tamaño de página |
| Repos/autores/stats | API p95 ≤700 ms, sin full scan del corpus en Node | Agregación paginada; queries/bytes por página acotados y plan medido |
| Objetivo local | API p95 ≤1,5 s, sin esperar GitHub/LLM | Objetivo ≤2 s; cobertura/partialidad declaradas |
| ACK diez fuentes | API p95 ≤1 s excluyendo transferencia de captura | Sin esperar enriquecimiento externo; transacción medida bajo worker activo |
| Derivación local | p95 ≤30 s desde ACK bajo carga nominal definida | Procesamiento incremental; backlog y throughput documentados |
| UI ante indisponibilidad | Estado accionable dentro de 12 s | Mismo presupuesto; sin acumulación de requests |

Son puertas propuestas; no latencias logradas. Si el presupuesto total desde Bogotá no se cumple pese a SQL correcto, comprobar red/región/arranque con trazas antes de decidir capacidad o alojamiento. Si los proveedores fallan, conservar sus timeouts como errores de la fase externa y evaluar búsqueda local por separado.

### 4.4 Coste del grafo y backfill

Usar 100, 1.000 y 10.000 assets con mismo dominio. Medir número de aristas, filas procesadas y tiempo de una actualización de diez fuentes. Verificar que el camino nuevo no visita/reconstruye todos los assets del corpus en cada lote. Si hay cache de vecinos con k=20, aristas salientes ≤20n; registrar vecinos descartados/alcance en la vista, sin truncar las menciones reales.

Ejecutar backfill por lotes con ingesta concurrente y detener/reanudar a mitad. Medir transacciones, locks, conflictos CAS, backlog y gasto externo. Antes de cualquier lote RAG facturable, proyectar número de fuentes/chunks/tokens usando el modelo real y acordar un techo operativo en configuración; comparar gasto observado y evitar reembedding de fuentes ya verificadas.

## 5. Validación de datos y release

La implementación añadirá consultas de reconciliación versionadas con estas salidas; los scripts SQL de la auditoría son evidencia, no migraciones para aplicar.

| Comprobación | Esperado al cerrar |
|---|---|
| Asset sin fuente / ownership incorrecto | 0 |
| Fuente vigente sin derivado actual ni exclusión | 0 |
| Repo links/contextos frente a representación canónica | Sets iguales; diferencias justificadas explícitas =0 pendientes |
| Derivado de revisión futura o regresión | 0 |
| README bueno con contenido perdido por error posterior | 0 |
| Evidencia redundante por clave canónica | 0 |
| Dominio `blob:` o CSS de interfaz en documento seleccionado | 0 |
| Fuente privada fuera de corpus autorizado | 0 |
| Generación activa incompleta o con modelo/dimensión incompatible | 0 |
| Vector devuelto sin fuente vigente/permiso | 0 |
| Jobs pendientes locales tras backfill terminado | 0, aparte de nuevas ingestas identificadas |
| Segunda pasada de reparación sobre mismo snapshot | Sin cambios |

La reconciliación vectorial puede no completarse al mismo tiempo que la local; reportar ambas coberturas por separado. Un conteo igual entre dos sistemas no demuestra igualdad de IDs ni versiones.

Puerta de release por paquete:

1. Diff y migración revisados; entorno/contrato de compatibilidad documentados.
2. Casos Txx aplicables aprobados, incluyendo fallo recuperable del camino cambiado.
3. Preflight de esquema y configuración; commits de web/API/worker identificados.
4. Canary del paquete en corpus autorizado y verificación de resultados/estados/trace.
5. Observación de lag, errores y disponibilidad; expandir solo después del canary.
6. Rollback ensayado para código/flags y reparación; ningún job perdido durante pausa.

Para el release completo: 24 h de observación, ventanas con tráfico real y reconciliación diaria ejecutada. Registrar ausencia de tráfico si no permite certificar un SLO; no convertir silencio de métricas en evidencia de calidad.

## 6. Comandos actuales y comandos a incorporar

Los siguientes comandos existen en el checkout auditado. Ejecutarlos desde la raíz del repo, con la versión de Node que P00 haya fijado y dependencias instaladas. Son controles de regresión del código que exista al ejecutarlos; no certifican por sí solos el plan.

```bash
cd /root/indexer
npm test
npm run check:extension
npm run test:browser
npm run build:web
npm exec --workspace=indexbook-web -- astro check
```

La prueba browser necesita su navegador/preflight; `npm test` usa `--test-isolation=none`, que debe estar soportado por la versión elegida. No ejecutar importaciones con datos reales para comprobar que un comando existe. El script actual `npm run migrate:data --workspace=x-bookmarks-backend` importa JSON; no aplica esquema.

Comandos **propuestos** que se implementarán/documentarán con los paquetes correspondientes:

| Comando de root | Función | Paquete |
|---|---|---|
| `npm run doctor` | Validar config/capabilities, sin imprimir secretos ni mutar datos | P00 |
| `npm run schema:plan` | Diff/adopción y migraciones pendientes | P00 |
| `npm run schema:apply` | Aplicar migraciones con ledger y control explícito de entorno | P00 |
| `npm run demo` | Demo local con fixtures sin proveedores externos | P09 |
| `npm run worker` | Proceso worker supervisable | P03 |
| `npm run reconcile -- --dry-run` | Reportar drift y trabajo pendiente | P03/P08 |
| `npm run repair -- --dry-run --corpus <id>` | Diff de reparación por corpus | P08 |
| `npm run repair -- --run <id> --resume` | Ejecutar/reanudar un run preparado con CAS | P08 |
| `npm run test:integration` | PostgreSQL real, HTTP y workers | P02–P06 |
| `npm run test:web` | Carreras, estados y paginación en navegador | P01/P04 |
| `npm run bench:search` | Protocolo y resultados brutos de benchmark | P04 |
| `npm run rag:reconcile -- --dry-run` | Comparar manifiestos y IDs externos del scope | P06 |

Estos nombres no son instrucciones para ejecutar hoy. Cuando se implementen, su ayuda debe declarar entorno, entradas, impacto, salida, checkpoint y códigos de error. La guía de despliegue enlazará ejemplos completos con cwd correcto y secretos suministrados por el entorno, nunca pegados en comandos/versionados.
