# X Bookmarks Indexer MVP

MVP funcional para extraer bookmarks de X, ingerirlos por lotes en backend propio y consultarlos via busqueda avanzada y basada en objetivos.

## Estructura del Repositorio

- `backend/`: API HTTP en Node.js para recibir lotes, clasificar repositorios y procesar búsquedas.
- `web-astro/`: Aplicación frontend principal desarrollada con Astro y React.
- `extension/`: Extensión de Chrome (scraper + cola de ingesta + popup).
- `docs/`: Documentación técnica y diagramas de arquitectura.
  - `docs/requirements-and-design/`: Requerimientos de producto (PRD, SRS) y notas de diseño del proyecto.
- `tools/`: Utilidades locales e independientes de desarrollo.
  - `tools/live-query-console/`: Consola HTML básica e independiente conectada a la API real.
- `scripts/`: Scripts locales auxiliares (incluye generador de video demo en `scripts/demo-video`).

## Desarrollo y Workspaces

El repositorio está configurado como un **NPM Workspace** en la raíz para simplificar la gestión de dependencias y scripts de desarrollo en el entorno local.

### 1. Instalación Inicial
Para instalar todas las dependencias de todos los proyectos del workspace (backend, frontend y scripts de demo) en un solo paso, ejecuta en la raíz:
```bash
npm install
```

### 2. Comandos Útiles en la Raíz
Puedes ejecutar los comandos para cualquier subproyecto directamente desde el directorio raíz usando los siguientes alias de npm:

- **Iniciar Backend (Modo Desarrollo):**
  ```bash
  npm run dev:backend
  ```
- **Iniciar Frontend (Modo Desarrollo):**
  ```bash
  npm run dev:web
  ```
- **Construir el Frontend (Producción):**
  ```bash
  npm run build:web
  ```
- **Iniciar Backend (Producción):**
  ```bash
  npm run start:backend
  ```
- **Grabar el Video Demo:**
  ```bash
  npm run record:demo
  ```

### 3. Cargar la Extensión en Chrome
1. Ve a `chrome://extensions`.
2. Activa el **Modo de desarrollador** (esquina superior derecha).
3. Haz clic en **Cargar descomprimida** y selecciona la carpeta `extension/` de este repositorio.
4. Abre `https://x.com/i/bookmarks` en el navegador, abre el popup de la extensión y haz clic en **Sync now**.

## Arquitectura y Despliegue
- El backend persiste la información en **Supabase**.
- Guía detallada para despliegue a producción en [production-deploy.md](file:///c:/Users/Filipo/Documents/code/indexer/docs/production-deploy.md).
- Documentación del flujo de DevOps en [devops-flow.md](file:///c:/Users/Filipo/Documents/code/indexer/docs/devops-architecture/devops-flow.md).
