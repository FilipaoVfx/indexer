// Zero-dependency Prometheus metrics for the Indexer backend.
//
// Why hand-rolled instead of prom-client: the backend deliberately ships with
// only two runtime dependencies, runs on a raw node:http server, and must work
// offline on any host. This module emits the Prometheus text exposition format
// (v0.0.4) so Prometheus/Grafana consume it identically to any other exporter.
//
// It covers the three pillars typically expected by DevOps observability:
//   - RED metrics for the HTTP API (Rate, Errors, Duration)
//   - Business metrics (ingestion + search)
//   - Node.js process/runtime metrics (memory, CPU, event-loop lag, GC handles)
//
// Postgres/pgbouncer/storage depth is intentionally NOT collected here; it is
// scraped directly from Supabase's native privileged metrics endpoint. See
// docs/devops-architecture/observability.md.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";

const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

// Latency buckets tuned for a JSON API in front of a remote Postgres (Supabase).
const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let appVersion = "0.0.0";
try {
  const pkgPath = path.resolve(__dirname, "..", "package.json");
  appVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version || appVersion;
} catch {
  // package.json is optional at runtime; fall back to the default version.
}

function escapeLabelValue(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function formatLabels(labels) {
  const parts = [];
  for (const key of Object.keys(labels)) {
    const value = labels[key];
    if (value === undefined || value === null) continue;
    parts.push(`${key}="${escapeLabelValue(value)}"`);
  }
  return parts.length ? `{${parts.join(",")}}` : "";
}

function seriesKey(labels) {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join("|");
}

class Counter {
  constructor({ name, help }) {
    this.name = name;
    this.help = help;
    this.type = "counter";
    this.series = new Map();
  }

  inc(labels = {}, amount = 1) {
    if (!Number.isFinite(amount)) return;
    const key = seriesKey(labels);
    const existing = this.series.get(key);
    if (existing) {
      existing.value += amount;
    } else {
      this.series.set(key, { labels, value: amount });
    }
  }

  render() {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n`;
    if (this.series.size === 0) {
      out += `${this.name} 0\n`;
      return out;
    }
    for (const { labels, value } of this.series.values()) {
      out += `${this.name}${formatLabels(labels)} ${value}\n`;
    }
    return out;
  }
}

class Gauge {
  constructor({ name, help }) {
    this.name = name;
    this.help = help;
    this.type = "gauge";
    this.series = new Map();
  }

  set(labels = {}, value) {
    if (!Number.isFinite(value)) return;
    this.series.set(seriesKey(labels), { labels, value });
  }

  inc(labels = {}, amount = 1) {
    const key = seriesKey(labels);
    const existing = this.series.get(key);
    if (existing) existing.value += amount;
    else this.series.set(key, { labels, value: amount });
  }

  dec(labels = {}, amount = 1) {
    this.inc(labels, -amount);
  }

  render() {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n`;
    if (this.series.size === 0) {
      out += `${this.name} 0\n`;
      return out;
    }
    for (const { labels, value } of this.series.values()) {
      out += `${this.name}${formatLabels(labels)} ${value}\n`;
    }
    return out;
  }
}

class Histogram {
  constructor({ name, help, buckets = HTTP_DURATION_BUCKETS }) {
    this.name = name;
    this.help = help;
    this.type = "histogram";
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.series = new Map();
  }

  observe(labels = {}, value) {
    if (!Number.isFinite(value)) return;
    const key = seriesKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = {
        labels,
        sum: 0,
        count: 0,
        // counts[i] is cumulative: number of observations <= buckets[i].
        counts: new Array(this.buckets.length).fill(0)
      };
      this.series.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]) entry.counts[i] += 1;
    }
  }

  render() {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} histogram\n`;
    for (const entry of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i += 1) {
        const labels = { ...entry.labels, le: String(this.buckets[i]) };
        out += `${this.name}_bucket${formatLabels(labels)} ${entry.counts[i]}\n`;
      }
      const infLabels = { ...entry.labels, le: "+Inf" };
      out += `${this.name}_bucket${formatLabels(infLabels)} ${entry.count}\n`;
      out += `${this.name}_sum${formatLabels(entry.labels)} ${entry.sum}\n`;
      out += `${this.name}_count${formatLabels(entry.labels)} ${entry.count}\n`;
    }
    return out;
  }
}

// --- Application metric definitions -----------------------------------------

const httpRequestsTotal = new Counter({
  name: "indexer_http_requests_total",
  help: "Total HTTP requests handled by the backend, by method, route and status."
});

const httpRequestDuration = new Histogram({
  name: "indexer_http_request_duration_seconds",
  help: "HTTP request latency in seconds, by method, route and status."
});

const httpRequestsInFlight = new Gauge({
  name: "indexer_http_requests_in_flight",
  help: "HTTP requests currently being processed."
});

const httpRequestErrorsTotal = new Counter({
  name: "indexer_http_request_errors_total",
  help: "HTTP requests that ended in a handled error, by route and error code."
});

const searchRequestsTotal = new Counter({
  name: "indexer_search_requests_total",
  help: "Search operations served, by type (search/semantic/goal) and strategy."
});

const searchDuration = new Histogram({
  name: "indexer_search_duration_seconds",
  help: "Search backend latency in seconds (as reported by the store), by type and strategy."
});

const bookmarksIngestedTotal = new Counter({
  name: "indexer_bookmarks_ingested_total",
  help: "Bookmarks newly inserted into Supabase, by ingestion source."
});

const ingestBatchesTotal = new Counter({
  name: "indexer_ingest_batches_total",
  help: "Ingestion batches processed, by endpoint and status (ok/error)."
});

const appInfo = new Gauge({
  name: "indexer_app_info",
  help: "Static application info; value is always 1."
});
appInfo.set({ version: appVersion, node_version: process.versions.node }, 1);

const appMetrics = [
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
  httpRequestErrorsTotal,
  searchRequestsTotal,
  searchDuration,
  bookmarksIngestedTotal,
  ingestBatchesTotal,
  appInfo
];

// --- Process / runtime metrics ----------------------------------------------

// Event-loop delay is sampled continuously; we read aggregates at scrape time.
let loopDelay = null;
try {
  loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
} catch {
  loopDelay = null;
}

const processStartTimeSeconds = Date.now() / 1000 - process.uptime();

function renderProcessMetrics() {
  const lines = [];
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const cpuSeconds = (cpu.user + cpu.system) / 1e6;

  const push = (name, help, type, value, labels = {}) => {
    // Before the event loop has samples some aggregates are NaN; emit 0 so
    // panels start clean instead of showing gaps.
    const safeValue = Number.isFinite(value) ? value : 0;
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name}${formatLabels(labels)} ${safeValue}`);
  };

  push(
    "indexer_process_cpu_seconds_total",
    "Total user + system CPU time consumed by the process, in seconds.",
    "counter",
    cpuSeconds
  );
  push(
    "indexer_process_start_time_seconds",
    "Process start time since the Unix epoch, in seconds.",
    "gauge",
    processStartTimeSeconds
  );
  push(
    "indexer_process_uptime_seconds",
    "Process uptime in seconds.",
    "gauge",
    process.uptime()
  );
  push(
    "indexer_process_resident_memory_bytes",
    "Resident set size (RSS) of the process, in bytes.",
    "gauge",
    mem.rss
  );
  push(
    "indexer_nodejs_heap_size_total_bytes",
    "Total V8 heap size, in bytes.",
    "gauge",
    mem.heapTotal
  );
  push(
    "indexer_nodejs_heap_size_used_bytes",
    "Used V8 heap size, in bytes.",
    "gauge",
    mem.heapUsed
  );
  push(
    "indexer_nodejs_external_memory_bytes",
    "Memory used by C++ objects bound to JS, in bytes.",
    "gauge",
    mem.external
  );

  if (loopDelay) {
    push(
      "indexer_nodejs_eventloop_lag_seconds",
      "Mean event-loop delay since process start, in seconds.",
      "gauge",
      loopDelay.mean / 1e9
    );
    push(
      "indexer_nodejs_eventloop_lag_p99_seconds",
      "99th percentile event-loop delay, in seconds.",
      "gauge",
      loopDelay.percentile(99) / 1e9
    );
    push(
      "indexer_nodejs_eventloop_lag_max_seconds",
      "Maximum observed event-loop delay, in seconds.",
      "gauge",
      loopDelay.max / 1e9
    );
  }

  try {
    // Undocumented but stable enough for observability; guarded defensively.
    const handles = process._getActiveHandles?.() || [];
    const requests = process._getActiveRequests?.() || [];
    push(
      "indexer_nodejs_active_handles",
      "Number of active libuv handles.",
      "gauge",
      handles.length
    );
    push(
      "indexer_nodejs_active_requests",
      "Number of active libuv requests.",
      "gauge",
      requests.length
    );
  } catch {
    // Ignore if the internal APIs are unavailable.
  }

  return lines.join("\n") + "\n";
}

// --- Route normalization (bounds label cardinality) -------------------------

// Dynamic path segments are collapsed so each distinct ID does not create a new
// time series. Unknown paths collapse to a single "unmatched" bucket.
function normalizeRoute(method, pathname) {
  if (typeof pathname !== "string" || pathname.length === 0) return "unknown";

  // Strip a trailing slash (except root) for stable labels.
  const route = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  if (/^\/api\/github-readmes\/[^/]+\/[^/]+$/.test(route)) {
    return "/api/github-readmes/:owner/:repo";
  }
  if (/^\/related\/.+/.test(route)) return "/related/:id";
  if (/^\/graph\/.+/.test(route)) return "/graph/:id";

  const known = new Set([
    "/health",
    "/metrics",
    "/api/dashboard/overview",
    "/api/dashboard/datos-x",
    "/api/dashboard/crypto",
    "/api/dashboard/electoral",
    "/users",
    "/api/github-readmes",
    "/bookmarks/ids",
    "/api/bookmarks/ids",
    "/bookmarks/import-batch",
    "/api/bookmarks/import-batch",
    "/api/bookmarks/batch",
    "/api/bookmarks/search",
    "/search",
    "/search/semantic",
    "/search/goal",
    "/discover",
    "/clusters",
    "/trending"
  ]);

  if (known.has(route)) return route;
  return "unmatched";
}

function getPathname(req) {
  try {
    return new URL(req.url || "/", "http://internal").pathname;
  } catch {
    return "/";
  }
}

// --- Public registry --------------------------------------------------------

export const metrics = {
  contentType: CONTENT_TYPE,
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInFlight,
  httpRequestErrorsTotal,
  searchRequestsTotal,
  searchDuration,
  bookmarksIngestedTotal,
  ingestBatchesTotal,
  appInfo,
  render() {
    let out = "";
    for (const metric of appMetrics) {
      out += metric.render();
    }
    out += renderProcessMetrics();
    return out;
  }
};

// Attaches finish/close listeners that record RED metrics for one request.
// Returns nothing; the metrics path itself is excluded by the caller.
export function instrumentRequest(req, res, { skipPath } = {}) {
  const start = performance.now();
  let counted = false;
  httpRequestsInFlight.inc();

  const finalize = () => {
    if (counted) return;
    counted = true;
    httpRequestsInFlight.dec();

    const pathname = getPathname(req);
    if (skipPath && pathname === skipPath) return;

    const route = normalizeRoute(req.method, pathname);
    const labels = {
      method: req.method || "UNKNOWN",
      route,
      status_code: String(res.statusCode || 0)
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, (performance.now() - start) / 1000);
  };

  res.on("finish", finalize);
  res.on("close", finalize);
}

export { normalizeRoute };
