# X Bookmarks Indexer MVP

MVP funcional para extraer bookmarks de X, ingerirlos por lotes en backend propio y consultarlos via busqueda basica.

## Arquitectura

- `extension/`: Chrome extension (scraper + cola de ingesta + popup).
- `backend/`: API HTTP para recibir lotes y deduplicar.
- `docs/`: documentacion tecnica.

## Flujo rapido

1. Ejecutar backend:
   - `cd backend`
   - `npm run start`
2. Cargar extension en Chrome:
   - Ir a `chrome://extensions`
   - Activar modo desarrollador
   - Cargar carpeta `extension/`
3. Abrir `https://x.com/i/bookmarks`.
4. Abrir popup de la extension y pulsar `Sync now`.
5. Verificar API:
   - `GET http://localhost:8787/health`
   - `GET http://localhost:8787/api/bookmarks/search?user_id=local-user`

## Notas

- El backend persiste en Supabase.
- Ver `backend/src/migrate.js` para migrar datos locales a Supabase.
- El esquema SQL para Supabase/Postgres esta en `backend/sql/001_bookmarks_schema.sql`.
- Guia de despliegue a produccion: `docs/production-deploy.md`.

CI trigger test - 05/02/2026 08:50:07
