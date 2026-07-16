import { createHash, timingSafeEqual } from "node:crypto";
import { createHttpError } from "./http.js";

// Comparación timing-safe: se hashean ambos valores para igualar longitudes
// (timingSafeEqual lanza con buffers de distinto tamaño y compararlas directo
// filtraría la longitud de la key).
export function timingSafeEqualStrings(a, b) {
  const bufA = createHash("sha256").update(String(a)).digest();
  const bufB = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(bufA, bufB);
}

// Valida el header x-api-key contra la API_KEY configurada. Si API_KEY está
// vacía no bloquea (rollout: el deploy sin env no rompe la ingesta; el boot
// avisa por consola que la escritura queda abierta).
export function requireApiKey(req, apiKey) {
  if (!apiKey) {
    return;
  }

  const headerValue = req.headers["x-api-key"];
  const provided = typeof headerValue === "string" ? headerValue.trim() : "";

  if (!provided || !timingSafeEqualStrings(provided, apiKey)) {
    throw createHttpError(401, "invalid_api_key", "Missing or invalid x-api-key header");
  }
}

function getClientIp(req) {
  // Render corre detrás de proxy: la IP real llega en x-forwarded-for.
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

// Rate limiter en memoria por IP con ventana fija. Suficiente para un solo
// proceso (Render free/starter); si algún día hay varias instancias habría
// que moverlo a un store compartido.
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map();

  function sweep(now) {
    for (const [ip, entry] of hits) {
      if (entry.resetAt <= now) {
        hits.delete(ip);
      }
    }
  }

  return function checkRateLimit(req) {
    const now = Date.now();
    if (hits.size > 10_000) {
      sweep(now);
    }

    const ip = getClientIp(req);
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }

    entry.count += 1;
    if (entry.count > max) {
      const error = createHttpError(
        429,
        "rate_limited",
        "Too many write requests, retry later"
      );
      error.retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      throw error;
    }
  };
}
