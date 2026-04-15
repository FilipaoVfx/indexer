const DEFAULT_MAX_BODY_BYTES = 2_000_000;

export function createHttpError(statusCode, code, message) {
  const error = new Error(message || code || "http_error");
  error.statusCode = statusCode;
  error.code = code || "http_error";
  return error;
}

function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) {
    return false;
  }
  if (allowedOrigins.includes("*")) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

export function setCorsHeaders(req, res, allowedOrigins) {
  const origin = req.headers.origin;

  if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (isOriginAllowed(origin, allowedOrigins)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Supabase-Url, X-Supabase-Key"
  );
}

export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

export function parseJsonBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let done = false;

    const rejectOnce = (error) => {
      if (!done) {
        done = true;
        reject(error);
      }
    };

    req.on("data", (chunk) => {
      if (done) {
        return;
      }

      raw += chunk;
      if (Buffer.byteLength(raw) > maxBytes) {
        rejectOnce(
          createHttpError(413, "payload_too_large", "Request body too large")
        );
        req.destroy();
      }
    });

    req.on("end", () => {
      if (done) {
        return;
      }

      if (!raw.trim()) {
        done = true;
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(raw);
        done = true;
        resolve(parsed);
      } catch (_error) {
        rejectOnce(createHttpError(400, "invalid_json", "Invalid JSON payload"));
      }
    });

    req.on("error", (error) => {
      rejectOnce(createHttpError(400, "request_error", error.message));
    });
  });
}
