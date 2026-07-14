// Clasificador de repos v2 — LLM con taxonomía cerrada.
//
// Reemplaza el keyword-matching de repo-classifier.js (v1), que producía
// falsos positivos estructurales (openbb→dashboard, vtuber→security) y
// confidence saturada en 0.98. Aquí un modelo barato lee el README real y
// devuelve JSON validado contra la taxonomía; v1 queda como fallback si la
// llamada falla o no hay OPENAI_API_KEY.
//
// Cache: shouldRefreshRepoClassification re-clasifica solo si cambió el
// README o la versión del clasificador. Costo: ~$0.0005/repo (gpt-4o-mini).

import { classifyRepoReadme, REPO_CLASSIFIER_VERSION } from "./repo-classifier.js";

export const REPO_CLASSIFIER_LLM_VERSION = "repo_classifier_v3_llm";

const LLM_MODEL = process.env.CLASSIFIER_MODEL || "gpt-4o-mini";
const MAX_README_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 45_000;

// Taxonomía alineada al corpus real (agentes AI, skills, media, trading...).
const CATEGORIES = {
  ai_agent: "autonomous/coding agents, agent frameworks, Claude/GPT skills and plugins",
  llm_tool: "LLM utilities: prompting, routing, fine-tuning, inference, RAG building blocks",
  search_rag: "search engines, retrieval, embeddings, vector databases, RAG pipelines",
  dev_tool: "developer tooling: CLIs, editors, terminals, testing, build, debugging",
  ui_component: "UI libraries, design systems, animations, frontend components",
  media: "video/audio/image processing, generation, transcription, OCR, rendering",
  three_d: "3D graphics, engines, modeling, WebGL/three.js, gaussian splatting, game rendering, CAD, AR/VR",
  data_pipeline: "scraping, ETL, data extraction, enrichment, transformation",
  automation: "workflow automation, schedulers, bots, integration platforms",
  knowledge_docs: "note-taking, documentation, bookmarks, knowledge management, education",
  finance_trading: "trading bots, market data, financial analysis, crypto",
  security: "pentesting, vulnerability scanning, privacy, OSINT, hardening",
  communication: "chat, email, messaging, social media clients, support inboxes",
  infra: "self-hosting, deployment, containers, networking, observability, databases",
  app: "end-user applications that don't fit the above (games, OS-like, productivity)",
};

const MATURITY_VALUES = new Set(["unknown", "prototype", "usable", "production"]);
const COMPLEXITY_VALUES = new Set(["basic", "intermediate", "advanced"]);

function buildPrompt(row) {
  const readme = String(row?.content || "").slice(0, MAX_README_CHARS);
  const taxonomy = Object.entries(CATEGORIES)
    .map(([key, desc]) => `- ${key}: ${desc}`)
    .join("\n");

  return [
    `Classify this GitHub repository based on its README. Respond ONLY with JSON.`,
    ``,
    `Categories (choose primary + up to 2 secondary, ONLY from this list):`,
    taxonomy,
    ``,
    `JSON schema:`,
    `{`,
    `  "primary_category": "<category key>",`,
    `  "secondary_categories": ["<category key>", ...],`,
    `  "capabilities": ["<short verb phrase>", ... up to 6],`,
    `  "tech_stack": ["<language/framework>", ... up to 4],`,
    `  "maturity": "prototype|usable|production|unknown",`,
    `  "complexity": "basic|intermediate|advanced",`,
    `  "confidence": <0.0-1.0, how sure you are of primary_category>,`,
    `  "reason": "<one sentence: why this primary category>"`,
    `}`,
    ``,
    `Repository: ${row?.repo_slug || "unknown"}`,
    `README:`,
    readme || "(empty)",
  ].join("\n");
}

async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return JSON.parse(data?.choices?.[0]?.message?.content || "{}");
  } finally {
    clearTimeout(timer);
  }
}

const clean = (v) => String(v || "").trim().toLowerCase();
const cleanList = (v, max) =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter(Boolean))].slice(0, max);

function validate(raw, row) {
  const primary = CATEGORIES[clean(raw.primary_category)] ? clean(raw.primary_category) : null;
  const secondary = cleanList(raw.secondary_categories, 3)
    .map(clean)
    .filter((c) => CATEGORIES[c] && c !== primary);
  const maturity = MATURITY_VALUES.has(clean(raw.maturity)) ? clean(raw.maturity) : "unknown";
  const complexity = COMPLEXITY_VALUES.has(clean(raw.complexity)) ? clean(raw.complexity) : "intermediate";
  const confidence = Math.min(0.99, Math.max(0.05, Number(raw.confidence) || 0.5));
  const reason = String(raw.reason || "").slice(0, 400);

  if (!primary) throw new Error(`invalid primary_category: ${raw.primary_category}`);

  return { primary, secondary, maturity, complexity, confidence, reason,
    capabilities: cleanList(raw.capabilities, 6),
    techStack: cleanList(raw.tech_stack, 4) };
}

/**
 * Clasifica con LLM; si falla, cae al keyword-matcher v1 (marcado con su
 * versión v1 para que un run futuro con LLM sano lo re-intente).
 * Mismo shape de retorno que classifyRepoReadme: { classification, evidenceRows }.
 */
export async function classifyRepoReadmeSmart(row, options = {}) {
  const now = options.now || new Date().toISOString();
  const repoSlug = String(row?.repo_slug || "").trim().toLowerCase();

  if (!process.env.OPENAI_API_KEY) {
    return classifyRepoReadme(row, options);
  }

  try {
    const raw = await callOpenAI(buildPrompt(row));
    const v = validate(raw, row);

    return {
      classification: {
        repo_slug: repoSlug,
        primary_category: v.primary,
        secondary_categories: v.secondary,
        capabilities: v.capabilities,
        input_types: [],
        output_types: [],
        integration_types: [],
        target_domains: [],
        tech_stack: v.techStack,
        deployment_modes: [],
        constraints: [],
        complexity: v.complexity,
        maturity: v.maturity,
        confidence: Number(v.confidence.toFixed(4)),
        classifier_version: REPO_CLASSIFIER_LLM_VERSION,
        score_breakdown: {
          method: "llm",
          model: LLM_MODEL,
          reason: v.reason,
          metadata: {
            status: row?.status || null,
            content_chars: Number(row?.content_chars || 0),
          },
        },
        created_at: now,
        updated_at: now,
      },
      evidenceRows: [
        {
          repo_slug: repoSlug,
          classifier_version: REPO_CLASSIFIER_LLM_VERSION,
          label_type: "categories",
          label_value: v.primary,
          evidence_text: v.reason || "llm classification",
          source_section: "llm",
          weight: v.confidence,
        },
      ],
    };
  } catch (err) {
    console.warn(`[classifier-llm] ${repoSlug}: ${err.message} — fallback v1`);
    return classifyRepoReadme(row, options);
  }
}

// Versión activa: gobierna qué filas se consideran desactualizadas.
export function activeClassifierVersion() {
  return process.env.OPENAI_API_KEY ? REPO_CLASSIFIER_LLM_VERSION : REPO_CLASSIFIER_VERSION;
}
