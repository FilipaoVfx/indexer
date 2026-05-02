export const REPO_CLASSIFIER_VERSION = "repo_classifier_v1";

const MAX_SECONDARY_CATEGORIES = 3;
const MAX_CAPABILITIES = 8;
const MAX_INPUT_TYPES = 5;
const MAX_OUTPUT_TYPES = 5;
const MAX_INTEGRATION_TYPES = 5;
const MAX_TARGET_DOMAINS = 4;
const MAX_TECH_STACK = 4;
const MAX_DEPLOYMENT_MODES = 3;
const MAX_CONSTRAINTS = 4;
const MAX_EVIDENCE_PER_LABEL = 2;

function weightedTerms(weight, values) {
  return values.map((value) => ({ value, weight }));
}

const RAW_TAXONOMY = {
  categories: {
    scraping: [
      ...weightedTerms(2.8, ["scraper", "scraping", "crawler", "crawling", "crawl"]),
      ...weightedTerms(2.2, ["data extraction", "extract data", "harvest data", "extract businesses"]),
      ...weightedTerms(1.6, ["extract", "extraction", "parse html", "parse website", "google maps"]),
    ],
    enrichment: [
      ...weightedTerms(2.4, ["enrichment", "enrich", "dedupe", "deduplicate", "normalize"]),
      ...weightedTerms(1.7, ["validate data", "clean data", "json-ld", "schema markup", "seo"]),
      ...weightedTerms(1.4, ["classification", "classify", "scoring"]),
    ],
    storage: [
      ...weightedTerms(2.4, ["database", "postgres", "postgresql", "sqlite", "mongodb", "vector database"]),
      ...weightedTerms(1.9, ["store embeddings", "persist data", "data store", "storage layer"]),
      ...weightedTerms(1.4, ["redis", "qdrant", "pinecone", "weaviate", "chroma"]),
    ],
    automation: [
      ...weightedTerms(2.5, ["automation", "automate", "workflow automation", "job runner"]),
      ...weightedTerms(2.0, ["workflow", "workflows", "trigger", "scheduler", "queue", "worker"]),
      ...weightedTerms(1.6, ["pipeline", "cron", "background job"]),
    ],
    dashboard: [
      ...weightedTerms(2.5, ["dashboard", "admin panel", "analytics dashboard"]),
      ...weightedTerms(2.0, ["charts", "charting", "visualization", "reporting"]),
      ...weightedTerms(1.5, ["frontend", "ui", "interface", "control panel"]),
    ],
    observability: [
      ...weightedTerms(2.5, ["observability", "monitoring", "session replay", "error tracking"]),
      ...weightedTerms(2.0, ["analytics", "telemetry", "metrics", "logging"]),
      ...weightedTerms(1.4, ["trace", "feature flags", "ab testing"]),
    ],
    security: [
      ...weightedTerms(2.6, ["security", "red team", "pentest", "pentesting"]),
      ...weightedTerms(2.1, ["vulnerability", "threat detection", "sandbox", "secure"]),
      ...weightedTerms(1.5, ["audit", "hardening", "linux server"]),
    ],
    orchestration: [
      ...weightedTerms(2.6, ["orchestration", "orchestrate", "multi-agent", "agent orchestration"]),
      ...weightedTerms(2.0, ["coordination", "handoff", "pipeline graph", "state machine"]),
      ...weightedTerms(1.5, ["dag", "graph workflow", "deploy platform", "self-hosted platform"]),
    ],
    search: [
      ...weightedTerms(2.5, ["search engine", "semantic search", "retrieval", "rag"]),
      ...weightedTerms(2.0, ["ranking", "full text search", "vector search", "embeddings"]),
      ...weightedTerms(1.6, ["indexing", "query engine", "search layer"]),
    ],
    agent_runtime: [
      ...weightedTerms(2.7, ["agent runtime", "ai coding agent", "autonomous agent", "copilot"]),
      ...weightedTerms(2.2, ["assistant", "multi agent", "pair programmer", "task master"]),
      ...weightedTerms(1.7, ["claude", "openhands", "editor agent", "terminal agent"]),
    ],
    communication: [
      ...weightedTerms(2.6, ["chat support", "customer support", "shared inbox", "live chat"]),
      ...weightedTerms(2.1, ["email automation", "send email", "whatsapp", "telegram", "smtp"]),
      ...weightedTerms(1.6, ["outreach", "campaign", "inbox", "messaging"]),
    ],
    content_generation: [
      ...weightedTerms(2.5, ["content generation", "generate content", "copywriting", "summarization"]),
      ...weightedTerms(2.0, ["template engine", "slide generation", "presentation generator"]),
      ...weightedTerms(1.5, ["render content", "write content", "draft content"]),
    ],
  },
  capabilities: {
    scrape_maps: [
      ...weightedTerms(3.0, ["google maps scraper", "scrape maps", "maps scraper", "google maps"]),
    ],
    extract_emails: [
      ...weightedTerms(2.7, ["extract emails", "email extraction", "find emails"]),
      ...weightedTerms(1.9, ["email finder", "email discovery"]),
    ],
    send_email: [
      ...weightedTerms(2.8, ["send email", "email outreach", "smtp", "mail merge"]),
      ...weightedTerms(1.8, ["campaigns", "newsletter"]),
    ],
    build_dashboard: [
      ...weightedTerms(2.8, ["dashboard", "admin panel", "analytics dashboard"]),
      ...weightedTerms(1.7, ["charts", "reporting", "visualization"]),
    ],
    expose_api: [
      ...weightedTerms(2.7, ["rest api", "graphql api", "api endpoint", "openapi", "swagger"]),
      ...weightedTerms(1.7, ["sdk", "webhook endpoint"]),
    ],
    run_workflows: [
      ...weightedTerms(2.7, ["workflow automation", "workflow engine", "run workflows"]),
      ...weightedTerms(1.8, ["pipeline", "trigger", "scheduler", "jobs"]),
    ],
    store_vectors: [
      ...weightedTerms(2.8, ["vector database", "vector store", "embeddings store"]),
      ...weightedTerms(1.9, ["qdrant", "pinecone", "weaviate", "chroma"]),
    ],
    parse_pdf: [
      ...weightedTerms(2.8, ["parse pdf", "pdf parser", "extract from pdf"]),
      ...weightedTerms(1.8, ["document parsing", "ocr", "pdf to markdown"]),
    ],
    route_models: [
      ...weightedTerms(2.8, ["model router", "route models", "multi model", "model selection"]),
      ...weightedTerms(1.8, ["provider routing", "fallback models"]),
    ],
    chat_support: [
      ...weightedTerms(2.8, ["live chat", "shared inbox", "customer support"]),
      ...weightedTerms(1.8, ["whatsapp", "chatwoot", "support ai"]),
    ],
    session_replay: [
      ...weightedTerms(2.8, ["session replay", "feature flags", "ab testing"]),
      ...weightedTerms(1.8, ["product analytics", "error tracking"]),
    ],
    code_generation: [
      ...weightedTerms(2.5, ["write code", "open pull request", "edit codebase", "pair programming"]),
      ...weightedTerms(1.8, ["software engineer agent", "terminal coding assistant"]),
    ],
  },
  integration_types: {
    cli: [
      ...weightedTerms(2.5, ["cli", "command line", "terminal", "pipx", "npm install -g"]),
    ],
    sdk: [
      ...weightedTerms(2.4, ["sdk", "client library"]),
    ],
    web_ui: [
      ...weightedTerms(2.6, ["web ui", "web interface", "browser ui", "web app"]),
      ...weightedTerms(1.7, ["dashboard", "admin panel"]),
    ],
    rest_api: [
      ...weightedTerms(2.7, ["rest api", "api endpoint", "openapi", "swagger"]),
      ...weightedTerms(1.7, ["http api", "json api"]),
    ],
    library: [
      ...weightedTerms(2.4, ["python library", "javascript library", "typescript library", "import "]),
      ...weightedTerms(1.7, ["package", "framework", "module"]),
    ],
    desktop_app: [
      ...weightedTerms(2.7, ["desktop app", "native app", "macos app", "electron"]),
      ...weightedTerms(1.8, ["swiftui", "desktop client"]),
    ],
    browser_extension: [
      ...weightedTerms(2.8, ["browser extension", "chrome extension", "firefox extension"]),
    ],
  },
  input_types: {
    url: [
      ...weightedTerms(2.0, ["url", "urls", "website url", "page url"]),
    ],
    text: [
      ...weightedTerms(2.0, ["text input", "plain text", "prompt", "markdown"]),
    ],
    file: [
      ...weightedTerms(2.3, ["file upload", "pdf", "document", "csv file", "json file"]),
    ],
    query: [
      ...weightedTerms(2.3, ["query", "search query", "keyword", "keywords"]),
    ],
    webhook: [
      ...weightedTerms(2.5, ["webhook", "webhooks", "callback"]),
    ],
    email: [
      ...weightedTerms(2.4, ["email input", "incoming email", "mailbox"]),
    ],
  },
  output_types: {
    json: [
      ...weightedTerms(2.3, ["json output", "returns json", "json api", "json"]),
    ],
    csv: [
      ...weightedTerms(2.5, ["csv export", "export csv", "csv output", "csv"]),
    ],
    dashboard: [
      ...weightedTerms(2.6, ["dashboard", "analytics ui", "visual dashboard"]),
    ],
    email: [
      ...weightedTerms(2.5, ["send email", "email campaign", "outbound email"]),
    ],
    embeddings: [
      ...weightedTerms(2.6, ["embeddings", "vector embeddings", "embedding vectors"]),
    ],
    report: [
      ...weightedTerms(2.4, ["report", "reports", "reporting"]),
    ],
    leads: [
      ...weightedTerms(2.7, ["leads", "lead generation", "prospecting leads"]),
    ],
  },
  tech_stack: {
    python: [
      ...weightedTerms(2.5, ["python", "pip install", "requirements.txt", "poetry", "pyproject"]),
    ],
    nodejs: [
      ...weightedTerms(2.5, ["node.js", "nodejs", "npm install", "package.json"]),
    ],
    javascript: [
      ...weightedTerms(2.3, ["javascript", "npm", "yarn"]),
    ],
    typescript: [
      ...weightedTerms(2.5, ["typescript", "tsconfig", ".ts"]),
    ],
    go: [
      ...weightedTerms(2.5, ["golang", "go install", "go build", "go mod"]),
    ],
    java: [
      ...weightedTerms(2.4, ["java", "maven", "gradle", "spring boot"]),
    ],
    rust: [
      ...weightedTerms(2.4, ["rust", "cargo", "crates.io"]),
    ],
    php: [
      ...weightedTerms(2.3, ["php", "composer"]),
    ],
    swift: [
      ...weightedTerms(2.6, ["swift", "swiftui", "xcode", "macos"]),
    ],
  },
  deployment_modes: {
    local: [
      ...weightedTerms(2.5, ["run locally", "local only", "local machine", "desktop app"]),
    ],
    self_hosted: [
      ...weightedTerms(2.7, ["self-hosted", "self hosted", "host it yourself", "docker compose"]),
    ],
    cloud: [
      ...weightedTerms(2.4, ["cloud", "saas", "hosted service", "deploy to"]),
    ],
  },
  constraints: {
    local_first: [
      ...weightedTerms(2.5, ["local-first", "local first", "works offline"]),
    ],
    self_hosted: [
      ...weightedTerms(2.6, ["self-hosted", "self hosted", "docker compose"]),
    ],
    requires_api_key: [
      ...weightedTerms(2.5, ["api key", "requires api key", "set your api key"]),
    ],
    open_source: [
      ...weightedTerms(2.2, ["open source", "opensource", "mit license", "apache license", "gpl"]),
    ],
    windows_friendly: [
      ...weightedTerms(2.4, ["windows", "powershell", "windows friendly"]),
    ],
  },
  target_domains: {
    local_business: [
      ...weightedTerms(2.8, ["local business", "google maps", "business listings"]),
    ],
    prospecting: [
      ...weightedTerms(2.7, ["prospecting", "lead generation", "sales outreach", "leads"]),
    ],
    documents: [
      ...weightedTerms(2.7, ["document processing", "pdf", "documents", "ocr"]),
    ],
    analytics: [
      ...weightedTerms(2.6, ["product analytics", "analytics", "session replay", "metrics"]),
    ],
    support: [
      ...weightedTerms(2.6, ["customer support", "shared inbox", "live chat"]),
    ],
    developer_tooling: [
      ...weightedTerms(2.6, ["developer tool", "coding assistant", "vs code", "codebase"]),
    ],
  },
};

const MATURITY_PRODUCTION_TERMS = [
  "production ready",
  "used in production",
  "battle tested",
  "enterprise ready",
  "stable release",
  "production grade",
];

const MATURITY_PROTOTYPE_TERMS = [
  "experimental",
  "prototype",
  "proof of concept",
  "proof-of-concept",
  "poc",
  "work in progress",
  "wip",
  "alpha",
  "beta",
];

const MATURITY_USABLE_TERMS = [
  "getting started",
  "installation",
  "quick start",
  "usage",
  "features",
];

const ADVANCED_COMPLEXITY_TERMS = [
  "kubernetes",
  "distributed",
  "multi-agent",
  "multi agent",
  "observability",
  "state machine",
  "vector database",
  "orchestration",
];

function clampNumber(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function ensureArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripMarkdown(value) {
  return collapseWhitespace(
    String(value || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[[^\]]*]\(([^)]+)\)/g, "$1")
      .replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1 $2")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/[*_~]/g, " ")
      .replace(/<\/?[^>]+>/g, " ")
  );
}

function normalizeSnippet(value, maxLength = 220) {
  const text = collapseWhitespace(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileTermRule(term, weight) {
  const normalizedTerm = normalizeText(term).replace(/[^a-z0-9]+/g, " ").trim();
  const parts = normalizedTerm.split(/\s+/).filter(Boolean);
  const pattern = parts.length === 0
    ? null
    : new RegExp(`(^|[^a-z0-9])${parts.map(escapeRegex).join("[\\s/_-]+")}($|[^a-z0-9])`, "i");

  return {
    term,
    normalizedTerm,
    weight,
    pattern
  };
}

function compileTaxonomy(rawTaxonomy) {
  return Object.fromEntries(
    Object.entries(rawTaxonomy).map(([family, labels]) => [
      family,
      Object.fromEntries(
        Object.entries(labels).map(([label, rules]) => [
          label,
          rules
            .map((rule) => compileTermRule(rule.value, rule.weight))
            .filter((rule) => rule.pattern)
        ])
      )
    ])
  );
}

const COMPILED_TAXONOMY = compileTaxonomy(RAW_TAXONOMY);

function extractHeadings(markdown) {
  return [...String(markdown || "").matchAll(/^#{1,6}\s+(.+)$/gm)]
    .map((match) => collapseWhitespace(match[1]))
    .filter(Boolean);
}

function splitMarkdownSections(markdown) {
  const sections = [];
  let current = null;

  for (const line of String(markdown || "").split(/\r?\n/)) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      if (current) sections.push(current);
      current = {
        heading: collapseWhitespace(headingMatch[1]),
        lines: []
      };
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  if (current) sections.push(current);
  return sections;
}

function collectSectionText(sections, headingTerms) {
  const normalizedTerms = headingTerms.map((term) => normalizeText(term));
  return sections
    .filter((section) => normalizedTerms.some((term) => normalizeText(section.heading).includes(term)))
    .map((section) => `${section.heading}\n${section.lines.join("\n")}`)
    .join("\n\n");
}

function buildSignalBuckets(row) {
  const markdown = String(row?.content || "");
  const plainText = stripMarkdown(markdown);
  const sections = splitMarkdownSections(markdown);
  const headings = extractHeadings(markdown).join("\n");
  const intro = plainText.split(/(?<=[.!?])\s+/).slice(0, 12).join(" ");
  const features = collectSectionText(sections, [
    "features",
    "feature",
    "capabilities",
    "what it does",
    "highlights"
  ]);
  const usage = collectSectionText(sections, [
    "usage",
    "quick start",
    "examples",
    "example",
    "api",
    "cli"
  ]);
  const installation = collectSectionText(sections, [
    "installation",
    "install",
    "setup",
    "getting started"
  ]);
  const repoName = collapseWhitespace(
    `${row?.repo_slug || ""} ${row?.owner || ""} ${row?.repo || ""}`.replace(/[._/-]+/g, " ")
  );

  return [
    { name: "repo_name", weight: 3.2, raw: repoName },
    { name: "headings", weight: 2.4, raw: headings },
    { name: "intro", weight: 2.1, raw: intro },
    { name: "features", weight: 1.9, raw: features },
    { name: "usage", weight: 1.7, raw: usage },
    { name: "installation", weight: 1.4, raw: installation },
    { name: "readme", weight: 0.8, raw: plainText },
  ]
    .map((bucket) => ({
      ...bucket,
      raw: collapseWhitespace(bucket.raw),
      normalized: normalizeText(bucket.raw),
    }))
    .filter((bucket) => bucket.raw);
}

function buildEvidenceSnippet(rawText, term) {
  const text = collapseWhitespace(rawText);
  if (!text) return "";

  const parts = normalizeText(term).split(/\s+/).filter(Boolean);
  const pattern = parts.length === 0
    ? null
    : new RegExp(parts.map(escapeRegex).join(".*?"), "i");
  const match = pattern ? text.match(pattern) : null;

  if (!match || typeof match.index !== "number") {
    return normalizeSnippet(text);
  }

  const start = Math.max(0, match.index - 90);
  const end = Math.min(text.length, match.index + match[0].length + 90);
  return normalizeSnippet(text.slice(start, end));
}

function scoreFamily(familyName, compiledFamily, buckets) {
  const scores = new Map();
  const evidences = new Map();

  for (const [label, rules] of Object.entries(compiledFamily)) {
    let totalScore = 0;
    const labelEvidence = [];

    for (const bucket of buckets) {
      for (const rule of rules) {
        if (!rule.pattern.test(bucket.normalized)) {
          continue;
        }

        const score = rule.weight * bucket.weight;
        totalScore += score;
        labelEvidence.push({
          label_type: familyName,
          label_value: label,
          evidence_text: buildEvidenceSnippet(bucket.raw, rule.term),
          source_section: bucket.name,
          weight: score,
        });
      }
    }

    if (totalScore > 0) {
      scores.set(label, Number(totalScore.toFixed(4)));
      evidences.set(
        label,
        labelEvidence
          .sort((a, b) => b.weight - a.weight || a.source_section.localeCompare(b.source_section))
          .slice(0, MAX_EVIDENCE_PER_LABEL)
      );
    }
  }

  return { scores, evidences };
}

function sortScores(scoreMap) {
  return [...scoreMap.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
}

function pickLabels(scoreMap, options = {}) {
  const sorted = sortScores(scoreMap);
  if (sorted.length === 0) return [];

  const maxItems = options.maxItems || sorted.length;
  const minimumScore = options.minimumScore ?? 1;
  const topScore = sorted[0][1];
  const relativeThreshold = options.relativeThreshold ?? 0.45;

  return sorted
    .filter(([, score], index) => {
      if (score < minimumScore) return false;
      if (index === 0) return true;
      return score >= topScore * relativeThreshold;
    })
    .slice(0, maxItems)
    .map(([label]) => label);
}

function mapScores(scoreMap, limit = 8) {
  return Object.fromEntries(sortScores(scoreMap).slice(0, limit));
}

function hasAnyTerm(text, terms) {
  const normalized = normalizeText(text);
  return terms.some((term) => normalizeText(term) && normalized.includes(normalizeText(term)));
}

function inferMaturity(row, buckets) {
  const readmeText = buckets.map((bucket) => bucket.raw).join("\n\n");

  if (hasAnyTerm(readmeText, MATURITY_PROTOTYPE_TERMS)) {
    return "prototype";
  }

  if (hasAnyTerm(readmeText, MATURITY_PRODUCTION_TERMS)) {
    return "production";
  }

  if (
    row?.status === "ok" &&
    (
      Number(row?.content_chars || 0) >= 800 ||
      hasAnyTerm(readmeText, MATURITY_USABLE_TERMS)
    )
  ) {
    return "usable";
  }

  return row?.status === "ok" ? "usable" : "unknown";
}

function inferComplexity({ categories, capabilities, integrations, row, buckets }) {
  const readmeText = buckets.map((bucket) => bucket.raw).join("\n\n");
  const advancedSignals =
    ADVANCED_COMPLEXITY_TERMS.filter((term) => hasAnyTerm(readmeText, [term])).length +
    (categories.includes("orchestration") ? 1 : 0) +
    (categories.includes("agent_runtime") ? 1 : 0) +
    (categories.includes("search") ? 1 : 0) +
    (integrations.includes("rest_api") ? 0.5 : 0) +
    (capabilities.length >= 4 ? 1 : 0);

  if (advancedSignals >= 3) {
    return "advanced";
  }

  if (
    capabilities.length <= 2 &&
    integrations.every((value) => ["cli", "library", "sdk"].includes(value)) &&
    Number(row?.content_chars || 0) < 4500
  ) {
    return "basic";
  }

  return "intermediate";
}

function inferConfidence({ row, categoryScores, selectedLabels, buckets }) {
  const sortedCategories = sortScores(categoryScores);
  const topScore = sortedCategories[0]?.[1] || 0;
  const runnerUp = sortedCategories[1]?.[1] || 0;
  const selectedCount = selectedLabels.reduce(
    (total, values) => total + values.length,
    0
  );
  const contentChars = Number(row?.content_chars || 0);
  const contentFactor = Math.min(0.16, Math.log10(contentChars + 10) / 10);
  const separationFactor = topScore > 0
    ? Math.max(0, 1 - runnerUp / (topScore + 0.0001))
    : 0;
  const evidenceFactor = Math.min(0.18, buckets.length * 0.02);

  let confidence = row?.status === "ok" ? 0.28 : 0.1;
  confidence += Math.min(0.28, topScore / 10);
  confidence += Math.min(0.14, selectedCount * 0.018);
  confidence += contentFactor + evidenceFactor + separationFactor * 0.12;

  if (!sortedCategories.length && selectedCount === 0) {
    confidence = row?.status === "ok" ? 0.18 : 0.05;
  }

  return Number(clampNumber(confidence, 0.05, 0.98).toFixed(4));
}

function buildScoreBreakdown(familyScores, metadata) {
  return {
    categories: mapScores(familyScores.categories),
    capabilities: mapScores(familyScores.capabilities),
    input_types: mapScores(familyScores.input_types),
    output_types: mapScores(familyScores.output_types),
    integration_types: mapScores(familyScores.integration_types),
    target_domains: mapScores(familyScores.target_domains),
    tech_stack: mapScores(familyScores.tech_stack),
    deployment_modes: mapScores(familyScores.deployment_modes),
    constraints: mapScores(familyScores.constraints),
    metadata,
  };
}

function sanitizeJsonString(value) {
  const input = String(value || "").replace(/\u0000/g, "");
  let output = "";

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode = input.charCodeAt(index + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        output += input[index] + input[index + 1];
        index += 1;
      } else {
        output += "\uFFFD";
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\uFFFD";
      continue;
    }

    output += input[index];
  }

  return output;
}

function buildEvidenceRows(repoSlug, classifierVersion, selectedByFamily, evidenceByFamily) {
  const rows = [];

  for (const [family, labels] of Object.entries(selectedByFamily)) {
    const evidences = evidenceByFamily[family];
    if (!evidences) continue;

    for (const label of labels) {
      for (const evidence of evidences.get(label) || []) {
        rows.push({
          repo_slug: sanitizeJsonString(repoSlug),
          classifier_version: sanitizeJsonString(classifierVersion),
          label_type: sanitizeJsonString(evidence?.label_type || ""),
          label_value: sanitizeJsonString(evidence?.label_value || ""),
          evidence_text: sanitizeJsonString(evidence?.evidence_text || ""),
          source_section: sanitizeJsonString(evidence?.source_section || ""),
          weight: Number(evidence?.weight || 0),
        });
      }
    }
  }

  return rows;
}

function uniqueLabels(values) {
  return [...new Set(ensureArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

export function mapRepoClassificationRow(row) {
  if (!row) return null;

  return {
    repo_slug: row.repo_slug,
    primary_category: row.primary_category || null,
    secondary_categories: uniqueLabels(row.secondary_categories),
    capabilities: uniqueLabels(row.capabilities),
    input_types: uniqueLabels(row.input_types),
    output_types: uniqueLabels(row.output_types),
    integration_types: uniqueLabels(row.integration_types),
    target_domains: uniqueLabels(row.target_domains),
    tech_stack: uniqueLabels(row.tech_stack),
    deployment_modes: uniqueLabels(row.deployment_modes),
    constraints: uniqueLabels(row.constraints),
    complexity: row.complexity || "intermediate",
    maturity: row.maturity || "unknown",
    confidence: Number(row.confidence || 0),
    classifier_version: row.classifier_version || "",
    score_breakdown:
      row.score_breakdown && typeof row.score_breakdown === "object"
        ? row.score_breakdown
        : {},
    updated_at: row.updated_at || null,
  };
}

export function classifyRepoReadme(row, options = {}) {
  const now = options.now || new Date().toISOString();
  const repoSlug = String(row?.repo_slug || "").trim().toLowerCase();
  const buckets = buildSignalBuckets(row);
  const familyScores = {};
  const evidenceByFamily = {};

  for (const [family, compiledFamily] of Object.entries(COMPILED_TAXONOMY)) {
    const result = scoreFamily(family, compiledFamily, buckets);
    familyScores[family] = result.scores;
    evidenceByFamily[family] = result.evidences;
  }

  const sortedCategories = sortScores(familyScores.categories);
  const primaryCategory =
    sortedCategories[0] && sortedCategories[0][1] >= 1.2
      ? sortedCategories[0][0]
      : null;

  const secondaryCategories = primaryCategory
    ? pickLabels(
        new Map(sortedCategories.filter(([label]) => label !== primaryCategory)),
        {
          maxItems: MAX_SECONDARY_CATEGORIES,
          minimumScore: 1.1,
          relativeThreshold: 0.55,
        }
      )
    : pickLabels(familyScores.categories, {
        maxItems: MAX_SECONDARY_CATEGORIES,
        minimumScore: 1.1,
        relativeThreshold: 0.55,
      });

  const capabilities = pickLabels(familyScores.capabilities, {
    maxItems: MAX_CAPABILITIES,
    minimumScore: 1.15,
    relativeThreshold: 0.4,
  });
  const inputTypes = pickLabels(familyScores.input_types, {
    maxItems: MAX_INPUT_TYPES,
    minimumScore: 1.05,
    relativeThreshold: 0.5,
  });
  const outputTypes = pickLabels(familyScores.output_types, {
    maxItems: MAX_OUTPUT_TYPES,
    minimumScore: 1.05,
    relativeThreshold: 0.5,
  });
  const integrationTypes = pickLabels(familyScores.integration_types, {
    maxItems: MAX_INTEGRATION_TYPES,
    minimumScore: 1.1,
    relativeThreshold: 0.45,
  });
  const targetDomains = pickLabels(familyScores.target_domains, {
    maxItems: MAX_TARGET_DOMAINS,
    minimumScore: 1.15,
    relativeThreshold: 0.45,
  });
  const techStack = pickLabels(familyScores.tech_stack, {
    maxItems: MAX_TECH_STACK,
    minimumScore: 1.05,
    relativeThreshold: 0.45,
  });
  const deploymentModes = pickLabels(familyScores.deployment_modes, {
    maxItems: MAX_DEPLOYMENT_MODES,
    minimumScore: 1.1,
    relativeThreshold: 0.45,
  });
  const constraints = pickLabels(familyScores.constraints, {
    maxItems: MAX_CONSTRAINTS,
    minimumScore: 1.15,
    relativeThreshold: 0.45,
  });

  const maturity = inferMaturity(row, buckets);
  const complexity = inferComplexity({
    categories: primaryCategory
      ? [primaryCategory, ...secondaryCategories]
      : secondaryCategories,
    capabilities,
    integrations: integrationTypes,
    row,
    buckets,
  });
  const confidence = inferConfidence({
    row,
    categoryScores: familyScores.categories,
    selectedLabels: [
      primaryCategory ? [primaryCategory] : [],
      secondaryCategories,
      capabilities,
      inputTypes,
      outputTypes,
      integrationTypes,
      targetDomains,
      techStack,
      deploymentModes,
      constraints,
    ],
    buckets,
  });

  const selectedByFamily = {
    categories: uniqueLabels(
      primaryCategory ? [primaryCategory, ...secondaryCategories] : secondaryCategories
    ),
    capabilities,
    input_types: inputTypes,
    output_types: outputTypes,
    integration_types: integrationTypes,
    target_domains: targetDomains,
    tech_stack: techStack,
    deployment_modes: deploymentModes,
    constraints,
  };

  return {
    classification: {
      repo_slug: repoSlug,
      primary_category: primaryCategory,
      secondary_categories: secondaryCategories,
      capabilities,
      input_types: inputTypes,
      output_types: outputTypes,
      integration_types: integrationTypes,
      target_domains: targetDomains,
      tech_stack: techStack,
      deployment_modes: deploymentModes,
      constraints,
      complexity,
      maturity,
      confidence,
      classifier_version: REPO_CLASSIFIER_VERSION,
      score_breakdown: buildScoreBreakdown(familyScores, {
        status: row?.status || null,
        content_chars: Number(row?.content_chars || 0),
        bucket_count: buckets.length,
      }),
      created_at: now,
      updated_at: now,
    },
    evidenceRows: buildEvidenceRows(
      repoSlug,
      REPO_CLASSIFIER_VERSION,
      selectedByFamily,
      evidenceByFamily
    ),
  };
}
