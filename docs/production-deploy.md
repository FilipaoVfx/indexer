# Production Deploy Guide

This project has two deployable parts:

- `backend/`: public HTTPS API
- `extension/`: Chrome extension installed by end users

The extension depends on the backend. They are distributed separately.

## 1. Deploy Backend

1. Choose host: Railway, Render, Fly.io, VPS, or similar.
2. Deploy `backend/` as a Node.js service.
3. Set environment variables:
   - `PORT=8787` (or host-provided port)
   - `MAX_BATCH_SIZE=100`
   - `ALLOWED_ORIGINS=https://your-web-app.example.com,chrome-extension://<your-extension-id>`
   - `SUPABASE_URL=https://your-project.supabase.co`
   - `SUPABASE_ANON_KEY=...` (or `SUPABASE_SERVICE_ROLE_KEY`, based on your policy)
4. Validate health endpoint:
   - `GET https://your-backend.example.com/health`
5. Migrate local JSON to Supabase (one-time):
   - `cd backend`
   - `npm run migrate`

## 2. Prepare Extension For Production

Before publishing, update these values:

1. `extension/background.js`
   - `DEFAULT_API_BASE_URL` -> your deployed backend URL.
2. `extension/popup.html`
   - `Backend URL` placeholder -> your deployed backend URL (optional but recommended).
3. `extension/manifest.json`
   - Ensure `host_permissions` includes your backend origin, for example:
     - `https://your-backend.example.com/*`

## 3. Package Extension

From repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1
```

Output:

- `dist/x-bookmarks-extension.zip`

## 4. Publish To Chrome Web Store

1. Create/update developer listing.
2. Upload `dist/x-bookmarks-extension.zip`.
3. Complete privacy/disclosure fields:
   - What data is collected from X pages.
   - How bookmark content is transmitted/stored.
4. Submit for review.

## 5. Post-Deploy Smoke Test

1. Install extension package.
2. Set `Backend URL` in popup.
3. Open `https://x.com/i/bookmarks`.
4. Run `Sync now`.
5. Confirm:
   - popup shows progress and successful enqueues
   - backend `/health` responds
   - rows appear in Supabase table `bookmarks`

## 6. Security Checklist

1. Do not expose `SUPABASE_SERVICE_ROLE_KEY` in extension code.
2. Restrict `ALLOWED_ORIGINS`; avoid `*` in production.
3. Add server-side auth for multi-tenant usage (recommended next step).
4. Add rate limiting and request logging on backend.
