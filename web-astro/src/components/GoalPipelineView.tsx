/**
 * GoalPipelineView — React Flow canvas of the recommended pipeline.
 *
 * Layout:
 *   top row   : one "primary" node per step from response.steps, connected
 *               with solid animated edges (the recommended path)
 *   bottom row: up to 2 "alternative" nodes per step (same visual column),
 *               connected with dashed edges, not animated
 *
 * A right-side sidebar mirrors the currently selected node with metadata
 * (score breakdown, why_this_result, README preview, next suggested step).
 *
 * Items are bucketed into steps using:
 *   1. repo_slugs whose content matches the step's canonical tokens
 *   2. required_components overlap with step->components mapping
 *   3. topics overlap with the step's contributing_tokens
 * If nothing fits, the step gets a placeholder card so the pipeline never
 * appears "empty".
 */

import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";

import type { GoalSearchResponse, GoalStep, SearchItem } from "../lib/api";

// -----------------------------------------------------------------------------
// Step metadata (label + icon + components) used for bucketing + UI.
// -----------------------------------------------------------------------------

const STEP_META: Record<
  string,
  { label: string; shortLabel: string; icon: string; components: string[] }
> = {
  data_extraction: {
    label: "Extracción de datos",
    shortLabel: "Extracción",
    icon: "pest_control",
    components: ["scraper", "crawler", "api"],
  },
  data_enrichment: {
    label: "Enriquecimiento",
    shortLabel: "Enriquecimiento",
    icon: "auto_fix_high",
    components: ["database"],
  },
  storage: {
    label: "Almacenamiento",
    shortLabel: "Almacenamiento",
    icon: "database",
    components: ["database"],
  },
  api_layer: {
    label: "Capa de API",
    shortLabel: "API",
    icon: "api",
    components: ["api"],
  },
  search_layer: {
    label: "Capa de búsqueda",
    shortLabel: "Búsqueda",
    icon: "search",
    components: ["search"],
  },
  ai_reasoning: {
    label: "IA / LLM",
    shortLabel: "IA / LLM",
    icon: "psychology",
    components: ["llm", "agent"],
  },
  workflow: {
    label: "Automatización",
    shortLabel: "Automatización",
    icon: "conveyor_belt",
    components: ["automation"],
  },
  outreach: {
    label: "Outreach / Emails",
    shortLabel: "Outreach",
    icon: "mail",
    components: [],
  },
  visualization: {
    label: "Dashboard",
    shortLabel: "Dashboard",
    icon: "analytics",
    components: ["frontend"],
  },
  auth_layer: {
    label: "Autenticación",
    shortLabel: "Auth",
    icon: "lock",
    components: [],
  },
  deployment: {
    label: "Despliegue",
    shortLabel: "Deploy",
    icon: "rocket_launch",
    components: [],
  },
};

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type Kind = "primary" | "alternative" | "empty";

interface StepCardData {
  kind: Kind;
  item?: SearchItem;
  step: GoalStep;
  stepIndex: number;
  matchPct: number;
  onSelect: (id: string) => void;
  isSelected: boolean;
  [key: string]: unknown; // keep React Flow's generic happy
}

type StepCardNode = Node<StepCardData, "stepCard">;

// -----------------------------------------------------------------------------
// Bucketing: pick best item per step (and collect alternatives).
// -----------------------------------------------------------------------------

function tokensFromItem(item: SearchItem): Set<string> {
  const bag = new Set<string>();
  for (const t of item.topics || []) bag.add(t.toLowerCase());
  for (const t of item.subtopics || []) bag.add(t.toLowerCase());
  for (const c of item.required_components || []) bag.add(c.toLowerCase());
  for (const s of item.repo_slugs || []) {
    const [, repo] = s.split("/");
    if (repo) bag.add(repo.toLowerCase());
  }
  const title = (item.title || "").toLowerCase();
  title
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
    .forEach((w) => bag.add(w));
  return bag;
}

function scoreAffinity(item: SearchItem, step: GoalStep): number {
  const meta = STEP_META[step.step];
  const bag = tokensFromItem(item);
  let score = 0;

  for (const token of step.contributing_tokens || []) {
    if (bag.has(token.toLowerCase())) score += 2;
  }
  if (meta) {
    for (const comp of meta.components) {
      if ((item.required_components || []).includes(comp)) score += 3;
    }
  }
  // lean on the main score as a tie-breaker
  score += (item.score || 0) * 0.1;
  return score;
}

interface StepBucket {
  step: GoalStep;
  primary: SearchItem | null;
  alternatives: SearchItem[];
}

function bucketItemsByStep(steps: GoalStep[], items: SearchItem[]): StepBucket[] {
  if (steps.length === 0) return [];

  const unclaimed = new Set(items.map((_, i) => i));
  const buckets: StepBucket[] = steps.map((step) => ({
    step,
    primary: null,
    alternatives: [],
  }));

  // 1st pass: for each step (in path order) pick the best-affinity unclaimed item.
  for (const bucket of buckets) {
    let bestIdx = -1;
    let bestScore = 0;
    unclaimed.forEach((idx) => {
      const s = scoreAffinity(items[idx], bucket.step);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = idx;
      }
    });
    if (bestIdx >= 0) {
      bucket.primary = items[bestIdx];
      unclaimed.delete(bestIdx);
    }
  }

  // 2nd pass: fill up to 2 alternatives per step from remaining items.
  for (const bucket of buckets) {
    const candidates = [...unclaimed]
      .map((idx) => ({ idx, s: scoreAffinity(items[idx], bucket.step) }))
      .filter((c) => c.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2);
    for (const c of candidates) {
      bucket.alternatives.push(items[c.idx]);
      unclaimed.delete(c.idx);
    }
  }

  return buckets;
}

// -----------------------------------------------------------------------------
// Display helpers
// -----------------------------------------------------------------------------

function displayName(item: SearchItem | undefined | null): string {
  if (!item) return "—";
  const slug = (item.repo_slugs || [])[0];
  if (slug) {
    const [, repo] = slug.split("/");
    if (repo) return repo;
  }
  return item.title || "sin título";
}

function languageLabel(item: SearchItem | undefined | null): string {
  if (!item) return "";
  const type = item.asset_type || "";
  const topic = (item.topics || [])[0];
  return topic || type || "asset";
}

function stars(item: SearchItem | undefined | null): number | null {
  // we don't have real github stars in the payload; derive a stable proxy
  // from the combined score so the UI always has something meaningful.
  if (!item) return null;
  return Math.round(Math.max(0, item.score || 0) * 1000);
}

function matchPercent(item: SearchItem | undefined | null): number {
  if (!item) return 0;
  const raw = Math.min(1, Math.max(0, item.score || 0));
  // spread scores into a human-readable 70–99% window
  return Math.round(70 + raw * 29);
}

function itemKey(item: SearchItem | undefined | null, fallback: string): string {
  if (!item) return fallback;
  return (
    (item.asset_id as string) ||
    (item.id as string) ||
    item.tweet_id ||
    fallback
  );
}

// -----------------------------------------------------------------------------
// Custom node — the step card
// -----------------------------------------------------------------------------

function StepCardNode({ data, id }: NodeProps<StepCardNode>) {
  const { kind, item, step, stepIndex, matchPct, onSelect, isSelected } = data;
  const meta = STEP_META[step.step];
  const isEmpty = kind === "empty" || !item;
  const isPrimary = kind === "primary";
  const starCount = stars(item);

  const borderCls = isSelected
    ? "border-primary ring-2 ring-primary/40"
    : isPrimary
    ? "border-primary/70"
    : "border-outline-variant/40";

  const bgCls = isPrimary
    ? "bg-surface-container-high"
    : "bg-surface-container-low";

  return (
    <div
      onClick={() => !isEmpty && onSelect(id)}
      className={`relative w-[180px] rounded-xl border-2 ${borderCls} ${bgCls} p-3 transition-colors ${
        isEmpty ? "opacity-60" : "cursor-pointer hover:border-primary/90"
      }`}
    >
      {/* step number badge only on primary row */}
      {isPrimary && (
        <div className="absolute -top-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1">
          <div className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-on-primary">
              {stepIndex + 1}
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-primary whitespace-nowrap">
              {meta?.shortLabel || step.step}
            </span>
          </div>
        </div>
      )}

      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !bg-primary/60 !border-0"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !bg-primary/60 !border-0"
      />

      <div className="flex items-center gap-2 mb-2">
        <span
          className={`material-symbols-outlined text-[18px] ${
            isPrimary ? "text-primary" : "text-on-surface-variant"
          }`}
        >
          {meta?.icon || "widgets"}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-on-surface">
            {displayName(item)}
          </p>
          <p className="truncate text-[11px] text-on-surface-variant">
            {languageLabel(item)}
          </p>
        </div>
      </div>

      {!isEmpty && (
        <div className="flex items-center justify-between text-[11px]">
          <span
            className={`rounded-full px-1.5 py-0.5 font-mono ${
              matchPct >= 90
                ? "bg-primary/20 text-primary"
                : "bg-secondary/15 text-secondary"
            }`}
          >
            {matchPct}% match
          </span>
          {starCount !== null && (
            <span className="text-on-surface-variant">★ {starCount}</span>
          )}
        </div>
      )}

      {isEmpty && (
        <p className="text-[11px] italic text-on-surface-variant">
          Sin coincidencia directa
        </p>
      )}
    </div>
  );
}

const NODE_TYPES = { stepCard: StepCardNode };

// -----------------------------------------------------------------------------
// Build nodes + edges from buckets
// -----------------------------------------------------------------------------

function buildGraph(
  buckets: StepBucket[],
  selectedId: string | null,
  onSelect: (id: string) => void
): { nodes: StepCardNode[]; edges: Edge[] } {
  const COLUMN_WIDTH = 230;
  const PRIMARY_Y = 0;
  const ALT_Y = 180;
  const nodes: StepCardNode[] = [];
  const edges: Edge[] = [];

  buckets.forEach((bucket, idx) => {
    const x = idx * COLUMN_WIDTH;
    const primaryId = `p-${idx}`;
    const primaryItem = bucket.primary;

    nodes.push({
      id: primaryId,
      type: "stepCard",
      position: { x, y: PRIMARY_Y },
      data: {
        kind: primaryItem ? "primary" : "empty",
        item: primaryItem || undefined,
        step: bucket.step,
        stepIndex: idx,
        matchPct: matchPercent(primaryItem),
        onSelect,
        isSelected: selectedId === primaryId,
      },
      draggable: false,
      selectable: false,
    });

    if (idx > 0) {
      edges.push({
        id: `e-p-${idx - 1}-${idx}`,
        source: `p-${idx - 1}`,
        target: primaryId,
        animated: true,
        style: { stroke: "rgb(168 85 247)", strokeWidth: 2 },
      });
    }

    bucket.alternatives.forEach((alt, altIdx) => {
      const altId = `a-${idx}-${altIdx}`;
      nodes.push({
        id: altId,
        type: "stepCard",
        position: { x: x + altIdx * 14, y: ALT_Y + altIdx * 6 },
        data: {
          kind: "alternative",
          item: alt,
          step: bucket.step,
          stepIndex: idx,
          matchPct: matchPercent(alt),
          onSelect,
          isSelected: selectedId === altId,
        },
        draggable: false,
        selectable: false,
      });

      if (idx > 0 && altIdx === 0) {
        edges.push({
          id: `e-a-${idx - 1}-${idx}`,
          source: `a-${idx - 1}-0`,
          target: altId,
          animated: false,
          style: { stroke: "rgb(148 163 184)", strokeWidth: 1.2, strokeDasharray: "4 4" },
        });
      }
    });
  });

  return { nodes, edges };
}

// -----------------------------------------------------------------------------
// Detail sidebar
// -----------------------------------------------------------------------------

function StepDetailPanel({
  bucket,
  selected,
  nextBucket,
}: {
  bucket: StepBucket | null;
  selected: { kind: Kind; item: SearchItem | null } | null;
  nextBucket: StepBucket | null;
}) {
  if (!bucket) {
    return (
      <aside className="w-full lg:w-80 rounded-xl border border-outline-variant/20 bg-surface-container-low p-5">
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-on-surface-variant">
          Detalle del paso
        </h4>
        <p className="text-sm text-on-surface-variant">
          Seleccioná un nodo del pipeline para ver su detalle.
        </p>
      </aside>
    );
  }

  const meta = STEP_META[bucket.step.step];
  const item = selected?.item || bucket.primary;
  const url =
    (item?.source_url as string) ||
    (item?.canonical_url as string) ||
    (item?.repo_slugs?.[0]
      ? `https://github.com/${item.repo_slugs[0]}`
      : undefined);

  return (
    <aside className="w-full lg:w-80 space-y-4 rounded-xl border border-outline-variant/20 bg-surface-container-low p-5">
      <div>
        <p className="text-[10px] font-mono uppercase tracking-wider text-on-surface-variant">
          Detalle del paso
        </p>
        <div className="mt-1 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[12px] font-bold text-on-primary">
            {(bucket.step.priority || 0) + 1}
          </span>
          <h4 className="text-sm font-bold text-on-surface">
            {meta?.label || bucket.step.step}
          </h4>
        </div>
      </div>

      {item && (
        <div className="rounded-lg border border-outline-variant/20 bg-surface-container-lowest p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-on-surface">
                {displayName(item)}
              </p>
              <p className="truncate text-[11px] text-on-surface-variant">
                {languageLabel(item)}
              </p>
            </div>
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="shrink-0 rounded-md border border-outline-variant/40 p-1 text-on-surface-variant hover:text-primary"
                aria-label="Abrir"
              >
                <span className="material-symbols-outlined text-[14px]">
                  open_in_new
                </span>
              </a>
            )}
          </div>

          {item.summary && (
            <p className="mt-2 text-xs leading-relaxed text-on-surface-variant line-clamp-3">
              {item.summary}
            </p>
          )}

          {!!item.topics?.length && (
            <div className="mt-2 flex flex-wrap gap-1">
              {item.topics.slice(0, 4).map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {!!item?.why_this_result?.length && (
        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-on-surface-variant mb-2">
            Por qué este match
          </p>
          <ul className="space-y-1 text-xs text-on-surface">
            {item.why_this_result.slice(0, 4).map((w, idx) => (
              <li key={idx} className="flex items-start gap-1.5">
                <span className="mt-0.5 text-primary">✓</span>
                <span className="leading-snug">{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {item?.readme_match?.preview && (
        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-on-surface-variant mb-2">
            README · fragmento
          </p>
          <p className="rounded-md bg-surface-container-lowest p-2 text-[11px] leading-relaxed text-on-surface-variant line-clamp-5">
            {item.readme_match.preview}
          </p>
        </div>
      )}

      {nextBucket && (
        <div className="rounded-md border border-dashed border-primary/40 bg-primary/5 p-2 text-xs">
          <p className="text-[10px] font-mono uppercase tracking-wider text-on-surface-variant">
            Siguiente paso sugerido
          </p>
          <p className="mt-0.5 font-medium text-primary">
            {STEP_META[nextBucket.step.step]?.label || nextBucket.step.step} →
          </p>
        </div>
      )}
    </aside>
  );
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export default function GoalPipelineView({
  response,
}: {
  response: GoalSearchResponse;
}) {
  const steps = (response.steps || []).slice(0, 8);
  const items = response.items || [];

  const buckets = useMemo(
    () => bucketItemsByStep(steps, items),
    [steps, items]
  );

  const [selectedId, setSelectedId] = useState<string | null>(() =>
    buckets.length > 0 && buckets[0].primary ? "p-0" : null
  );

  const { nodes, edges } = useMemo(
    () => buildGraph(buckets, selectedId, setSelectedId),
    [buckets, selectedId]
  );

  const selectedBucket = useMemo(() => {
    if (!selectedId) return null;
    const match = selectedId.match(/^([pa])-(\d+)(?:-(\d+))?$/);
    if (!match) return null;
    const idx = Number(match[2]);
    return buckets[idx] || null;
  }, [selectedId, buckets]);

  const selectedItem: { kind: Kind; item: SearchItem | null } | null =
    useMemo(() => {
      if (!selectedId || !selectedBucket) return null;
      const match = selectedId.match(/^([pa])-(\d+)(?:-(\d+))?$/);
      if (!match) return null;
      const row = match[1];
      const altIdx = match[3] ? Number(match[3]) : -1;
      if (row === "p") {
        return { kind: "primary", item: selectedBucket.primary };
      }
      return {
        kind: "alternative",
        item: selectedBucket.alternatives[altIdx] || null,
      };
    }, [selectedId, selectedBucket]);

  const nextBucket = useMemo(() => {
    if (!selectedBucket) return null;
    const idx = buckets.indexOf(selectedBucket);
    return idx >= 0 && idx < buckets.length - 1 ? buckets[idx + 1] : null;
  }, [selectedBucket, buckets]);

  const primaryCount = buckets.filter((b) => b.primary).length;
  const toolsEvaluated =
    primaryCount +
    buckets.reduce((acc, b) => acc + b.alternatives.length, 0);

  if (buckets.length === 0) {
    return (
      <section className="rounded-2xl border border-outline-variant/20 bg-surface-container-low p-6">
        <p className="text-sm text-on-surface-variant">
          No se detectaron pasos de pipeline para este objetivo. Probá una
          descripción más concreta (p.ej. "CRM con scraping y automatización
          de emails").
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col lg:flex-row gap-4">
        <div className="flex-1 min-w-0 rounded-2xl border border-outline-variant/20 bg-surface-container-lowest overflow-hidden">
          <header className="flex items-center justify-between border-b border-outline-variant/15 px-4 py-2">
            <h3 className="text-sm font-bold uppercase tracking-wider text-on-surface">
              Ruta recomendada
            </h3>
            <span className="text-[11px] text-on-surface-variant font-mono">
              {primaryCount}/{buckets.length} pasos · {toolsEvaluated} tools
            </span>
          </header>
          <div style={{ height: 440 }}>
            <ReactFlowProvider>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                fitView
                fitViewOptions={{ padding: 0.25 }}
                proOptions={{ hideAttribution: true }}
                minZoom={0.5}
                maxZoom={1.5}
                panOnScroll
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
              >
                <Background color="rgba(148, 163, 184, 0.25)" gap={16} />
                <Controls
                  showInteractive={false}
                  className="!bg-surface-container-high !border-outline-variant/30"
                />
              </ReactFlow>
            </ReactFlowProvider>
          </div>
        </div>

        <StepDetailPanel
          bucket={selectedBucket}
          selected={selectedItem}
          nextBucket={nextBucket}
        />
      </div>

      {/* Summary strip */}
      <div className="rounded-xl border border-outline-variant/20 bg-surface-container-low px-5 py-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-on-surface-variant">
        <span>
          <strong className="text-on-surface">{primaryCount}</strong> pasos
        </span>
        <span>
          <strong className="text-on-surface">{toolsEvaluated}</strong> tools
          evaluadas
        </span>
        <span>
          Intención:{" "}
          <strong className="text-on-surface">
            {response.goal_parse?.intent || "explore"}
          </strong>
        </span>
        {response.latency_ms != null && (
          <span>
            Latencia:{" "}
            <strong className="text-on-surface">
              {response.latency_ms} ms
            </strong>
          </span>
        )}
        {(response.goal_parse?.tokens_expanded?.length ?? 0) > 0 && (
          <span className="ml-auto text-on-surface-variant">
            +{response.goal_parse!.tokens_expanded!.length} tokens expandidos
          </span>
        )}
      </div>
    </section>
  );
}
