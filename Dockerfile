    FROM node:20-alpine AS backend-build
    WORKDIR /app/backend
    COPY backend/package*.json ./
    RUN npm ci --omit=dev
    COPY backend/ ./
    
    FROM node:20-alpine AS final
    WORKDIR /app
    
    COPY --from=backend-build /app/backend ./backend
    
    # Frontend ya buildeado por el job build_web (artifact)
    COPY web-astro/dist ./backend/public
    
    COPY extension ./extension
    
    ENV NODE_ENV=production
    ENV PORT=8080
    EXPOSE 8080
    
    WORKDIR /app/backend
    CMD ["node", "src/server.js"]