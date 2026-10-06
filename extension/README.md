# Extensión X Indexer 0.5.0

La captura usa las respuestas GraphQL de X y recurre al DOM cuando faltan. El popup inicia un trabajo persistente; puedes cerrarlo durante la importación. La pestaña de X debe permanecer abierta mientras se escanea. Después de encolar las capturas, el background puede entregarlas sin esa pestaña.

## Instalar y actualizar

1. Aplicar `backend/sql/017_preserve_bookmark_capture.sql` en Supabase, después de las migraciones anteriores. Añade metadatos de captura y funciones de merge; no borra bookmarks. El backend utiliza la clave `service_role`.
2. Desplegar el backend actualizado. Una versión antigua sin confirmaciones por ID deja los lotes pendientes; actualizar backend antes que extensión.
3. En `chrome://extensions`, activar modo desarrollador y cargar `extension/` sin comprimir, o recargar la instalación existente. Chrome 111 o posterior.
4. Recargar las pestañas de X: el puente se instala en `MAIN` desde `document_start`.
5. Configurar backend, usuario de Indexer y API key en el popup. Al cambiar a un dominio adicional, Chrome solicita acceso a ese dominio. El usuario configurado identifica el destino de Indexer; no detecta automáticamente qué cuenta de X está abierta.
6. Abrir `https://x.com/i/bookmarks` y pulsar **Importar bookmarks**. Conviene comenzar arriba de la lista.

La extensión solicita `unlimitedStorage` para conservar capturas y migrar la cola antigua sin duplicar datos dentro de una cuota de 10 MB. Los errores reales de disco/escritura siguen deteniendo la aceptación, mostrando un aviso y conservando el último estado confirmado. No borrar los datos de la extensión para resolver un fallo de entrega.

## Estados y recuperación

- **Escaneando**: X sigue proporcionando páginas; los drafts se guardan conforme llegan.
- **Enviando**: las capturas están aceptadas en almacenamiento local, pendientes del backend.
- **Guardado**: el backend confirmó los IDs correspondientes. Los rechazos no se cuentan como guardados.
- **Interrumpido**: se conserva lo capturado. Volver a iniciar desde una pestaña de bookmarks recupera los pendientes.
- **Requiere revisión**: abrir Diagnóstico, corregir configuración/payload y pulsar **Reintentar fallidos**.

El recorrido se informa por separado: **completo** requiere una señal terminal de GraphQL conocida, sin solicitudes pendientes, y comenzar arriba; **rango solicitado** indica el límite elegido; **parcial** indica que no hay evidencia suficiente de finalización. Un esquema desconocido, rate limit o DOM quieto no certifican recorrido completo. Un fallo observado conserva la marca de recorrido parcial aunque una página posterior sea sana; recargar X permite comenzar un recorrido nuevo.

El rango incluye pendientes recuperados. Se usa el orden de GraphQL cuando está disponible; el fallback conserva el orden de detección. Cada trabajo fija su selección por ID antes de enviar, por lo que confirmar un lote no desplaza los siguientes. **Descartar pendientes** elimina drafts no entregados y no cancela lotes ya aceptados por la cola.

Las capturas mantienen backend/usuario al aceptarse. Si cambia el backend, los lotes anteriores requieren volver a su configuración para reintentarlos. Una captura más completa recibida durante un envío se conserva y se entrega como actualización.

La captura automática congela el ID al hacer clic, espera el estado `removeBookmark` de X y rechaza un artículo reciclado. Solo acepta enlaces de autorrespuesta con autor y parent ID verificados. Resolver enlaces y buscar respuestas ocurre fuera de la entrega inicial.

## Archivos y pruebas

- `page-bridge.js`: lectura de respuestas, pertenencia al timeline y salud del parser.
- `content.js`: observación, selección estable, checkpoints y confirmación del guardado en X.
- `delivery-store.js`: journal serializado y migración de colas legacy.
- `background.js`: trabajos, entrega por lotes de 10, ACK por ID y reintentos.
- `popup.js` / `popup.html`: controles y estado persistido.

Desde la raíz, con Node 24:

```bash
npm ci --ignore-scripts
npm run check:extension
npm test
npx playwright install chromium
npm run test:browser
```

Las pruebas de navegador utilizan un perfil temporal, X simulado y un backend local. No sustituyen la validación con una sesión auténtica de X. Para empaquetar en Windows: `powershell -ExecutionPolicy Bypass -File scripts/package-extension.ps1`.

Ver [flujo de ingesta](../docs/ingesta-paso-a-paso.md) y [informe de robustecimiento](../docs/extension-hardening.md).
