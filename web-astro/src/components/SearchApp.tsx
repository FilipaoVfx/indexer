/**
 * SearchApp - experiencia de busqueda hibrida + busqueda por objetivo.
 * Conserva la exploracion de marcadores y conecta el flujo goal search a Supabase.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyBookmarkView } from "../lib/bookmark-view";
import {
  extractAllAuthors,
  extractContextLinks,
  extractDomains,
  extractGithubRepos,
  extractUsers,
  fetchUsers,
  formatDate,
  getDisplayAssetType,
  getPrimarySourceUrl,
  getCorpus,
  isGithubRepoUrl,
  safeDomain,
  searchGoal,
  searchHybrid,
  type GoalSearchResponse,
  type ParsedQuery,
  type SearchItem,
  type SearchResponse,
  type SearchMode,
  type UserSummary,
} from "../lib/api";
import {
  type Filters,
  hasAnySearchInput,
  hasRemoteSearchInput,
  useFilters,
  withBase,
} from "../lib/url-state";
import ResultCard from "./ResultCard";
import GoalPipelineView from "./GoalPipelineView";
import MentionedReposModal from "./MentionedReposModal";

const DEBOUNCE_MS = 400;

function formatModeLabel(mode: SearchMode): string {
  return mode === "goal" ? "Por objetivo" : "Hibrida";
}

function formatKindLabel(kind: "" | "media" | "links"): string {
  if (kind === "media") return "multimedia";
  if (kind === "links") return "enlaces";
  return "";
}

function formatIntentLabel(intent?: string): string {
  switch (intent) {
    case "build":
      return "construir";
    case "learn":
      return "aprender";
    case "compare":
      return "comparar";
    case "explore":
      return "explorar";
    default:
      return intent || "";
  }
}

function translateNextStep(step: string): string {
  const known: Record<string, string> = {
    "Validate the retrieval path first: corpus, parsing, and ranking.":
      "Valida primero la ruta de recuperacion: corpus, parseo y ranking.",
    "Model explicit relations early so related-content and route views can reuse them.":
      "Modela relaciones explicitas desde el inicio para reutilizarlas en contenido relacionado y vistas por ruta.",
  };
  return known[step] || step;
}

function formatGoalAssetType(value?: string): string {
  switch (value) {
    case "tool":
      return "Herramienta";
    case "thread":
      return "Hilo";
    case "repo":
      return "Repo";
    case "tutorial":
      return "Tutorial";
    case "article":
      return "Articulo";
    default:
      return value || "Recurso";
  }
}

function formatGoalDifficulty(value?: string): string {
  switch (value) {
    case "beginner":
      return "Basico";
    case "intermediate":
      return "Intermedio";
    case "advanced":
      return "Avanzado";
    default:
      return value || "";
  }
}

function stripInlineMarkup(value?: string): string {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildResultAnchorId(item: SearchItem): string | null {
  const rawId = item.asset_id || item.id || item.tweet_id;
  if (!rawId) return null;
  const normalized = String(rawId).replace(/[^A-Za-z0-9_-]+/g, "-");
  return normalized ? `goal-result-${normalized}` : null;
}

function getGoalCardTitle(item: SearchItem): string {
  return (
    stripInlineMarkup(item.title) ||
    stripInlineMarkup(item.summary) ||
    stripInlineMarkup(item.text_content) ||
    "Resultado sin titulo"
  );
}

function getGoalCardPreview(item: SearchItem): string {
  return (
    stripInlineMarkup(item.summary) ||
    stripInlineMarkup(item.text_content) ||
    stripInlineMarkup(item.highlight) ||
    "Sin descripcion adicional."
  );
}

function getGoalPrimaryUrl(item: SearchItem): string {
  return getPrimarySourceUrl(item);
}

function buildGoalSuggestion(sectionKey: string, item: SearchItem): string {
  const components = (item.required_components || []).slice(0, 2).join(" y ");
  const componentHint = components ? ` Pon atencion a ${components}.` : "";

  switch (sectionKey) {
    case "repos":
      return `Empieza por este repo para validar estructura, dependencias y camino de implementacion.${componentHint}`;
    case "tools":
      return `Usa esta herramienta como apoyo directo para ejecutar una parte del objetivo.${componentHint}`;
    case "tutorials":
      return `Recorre esta guia para convertir el objetivo en pasos concretos y comparar enfoques.${componentHint}`;
    case "examples":
      return `Toma este ejemplo como referencia practica y adapta solo el patron util para tu flujo.${componentHint}`;
    default:
      return `Este recurso te ayuda a avanzar en el objetivo con un siguiente paso claro.${componentHint}`;
  }
}

function getParsedQuery(response: SearchResponse | null): ParsedQuery | undefined {
  if (!response) return undefined;
  return response.mode === "goal"
    ? response.goal_parse?.parsed_query
    : response.parsed_query;
}

function getGoalResponse(response: SearchResponse | null): GoalSearchResponse | null {
  return response?.mode === "goal" ? response : null;
}

export default function SearchApp() {
  const [filters, update, reset] = useFilters();
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<
    (SearchResponse & { elapsed_ms: number }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [corpus, setCorpus] = useState<{ items: SearchItem[]; total: number } | null>(
    null
  );
  const [corpusError, setCorpusError] = useState<string | null>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);

  const debounceRef = useRef<number | null>(null);
  const remoteSearch = hasRemoteSearchInput(filters);
  const onDiscovery = !hasAnySearchInput(filters);
  const showLocalResults = filters.mode === "hybrid" && !onDiscovery && !remoteSearch;
  const showGoalPrompt = filters.mode === "goal" && !onDiscovery && !remoteSearch;

  const runSearch = useCallback(async () => {
    if (!remoteSearch) {
      setResponse(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = {
        user_id: filters.user || undefined,
        q: filters.q,
        author: filters.author,
        domain: filters.domain,
        from: filters.from,
        to: filters.to,
        media_only: filters.kind === "media",
        links_only: filters.kind === "links",
        sort: filters.sort || undefined,
        limit: filters.mode === "goal" ? 30 : 100,
      };

      const data =
        filters.mode === "goal" ? await searchGoal(params) : await searchHybrid(params);
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResponse(null);
    } finally {
      setLoading(false);
    }
  }, [filters, remoteSearch]);

  useEffect(() => {
    if (!remoteSearch) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(runSearch, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [remoteSearch, runSearch]);

  useEffect(() => {
    let mounted = true;
    fetchUsers()
      .then((items) => {
        if (!mounted) return;
        setUsers(items);
      })
      .catch(() => {
        if (!mounted) return;
        setUsers([]);
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (remoteSearch || showGoalPrompt) return;

    let mounted = true;
    setCorpus(null);
    setCorpusError(null);
    getCorpus(false, filters.user)
      .then((nextCorpus) => {
        if (!mounted) return;
        setCorpus(nextCorpus);
      })
      .catch((err) => {
        if (!mounted) return;
        setCorpusError(err instanceof Error ? err.message : String(err));
        setCorpus({ items: [], total: 0 });
      });

    return () => {
      mounted = false;
    };
  }, [filters.user, remoteSearch, showGoalPrompt]);

  const visibleItems = useMemo(() => {
    const source = showLocalResults ? corpus?.items || [] : response?.items || [];
    return applyBookmarkView(source, {
      kind: filters.kind,
      sort: filters.sort,
    });
  }, [corpus, filters.kind, filters.sort, response, showLocalResults]);

  const total =
    showLocalResults || filters.kind ? visibleItems.length : response?.total ?? 0;

  const resultsError = error || (showLocalResults ? corpusError : null);
  const resultsLoading = loading || (showLocalResults && !corpus && !corpusError);
  const strategyLabel = resultsError
    ? "OFFLINE"
    : showLocalResults
    ? filters.sort === "recent"
      ? "local_recent"
      : filters.kind
      ? `local_${filters.kind}`
      : "local"
    : response?.strategy || "---";
  const availableUsers = useMemo(
    () => (users.length > 0 ? users : extractUsers(corpus?.items || [])),
    [corpus, users]
  );

  return (
    <>
      <Header
        filters={filters}
        users={availableUsers}
        onChange={update}
        onSubmit={runSearch}
        showFilters={showFilters}
        setShowFilters={setShowFilters}
        elapsedLabel={
          response && !showLocalResults
            ? `${response.latency_ms ?? response.elapsed_ms} ms`
            : resultsLoading
            ? "..."
            : "--- ms"
        }
      />

      <div className="flex-1 overflow-y-auto bg-surface">
        {onDiscovery ? (
          <DiscoveryHome
            corpus={corpus}
            users={availableUsers}
            error={corpusError}
            onPick={(patch) => update(patch)}
          />
        ) : showGoalPrompt ? (
          <GoalPrompt
            onPickKeywordMode={() =>
              update({ mode: "hybrid", author: "", domain: "", from: "", to: "" })
            }
          />
        ) : (
          <ResultsView
            mode={filters.mode}
            loading={resultsLoading}
            error={resultsError}
            response={response}
            strategyLabel={strategyLabel}
            total={total}
            visibleItems={visibleItems}
            filters={filters}
            reset={reset}
            kindFilter={filters.kind}
          />
        )}
      </div>
    </>
  );
}

interface HeaderProps {
  filters: Filters;
  users: UserSummary[];
  onChange: (patch: Partial<Filters>) => void;
  onSubmit: () => void;
  showFilters: boolean;
  setShowFilters: (value: boolean) => void;
  elapsedLabel: string;
}

function Header({
  filters,
  users,
  onChange,
  onSubmit,
  showFilters,
  setShowFilters,
  elapsedLabel,
}: HeaderProps) {
  const placeholder =
    filters.mode === "goal"
      ? "Describe lo que quieres construir..."
      : "Busca en tu archivo de conocimiento...";

  return (
    <>
      <header className="bg-background flex justify-between items-center w-full px-6 h-20 z-50 border-b-2 border-primary">
        <div className="flex items-center gap-6 flex-1 min-w-0">
          <span className="text-lg font-bold text-primary font-headline hidden lg:block">
            <span className="text-secondary">$</span> search<span className="text-secondary">.</span>archive
          </span>
          <div className="hidden md:flex items-center gap-1 border-2 border-outline-variant bg-surface-container-low p-1">
            <ModeButton
              label="Hibrida"
              active={filters.mode === "hybrid"}
              onClick={() => onChange({ mode: "hybrid" })}
            />
            <ModeButton
              label="Objetivo"
              active={filters.mode === "goal"}
              onClick={() => onChange({ mode: "goal", kind: "", sort: "" })}
            />
          </div>
          <form
            className="relative w-full max-w-xl"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-primary font-bold text-sm">
              {filters.mode === "goal" ? "~>" : "$"}
            </span>
            <input
              value={filters.q}
              onChange={(event) => onChange({ q: event.target.value })}
              type="text"
              autoComplete="off"
              placeholder={placeholder}
              className="w-full bg-surface-container-lowest border-2 border-outline-variant focus:border-primary focus:ring-0 pl-10 pr-4 py-2.5 text-on-surface text-sm transition-colors font-mono placeholder:text-on-surface-variant"
            />
          </form>
        </div>
        <div className="flex items-center gap-4 ml-4">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="text-on-surface-variant hover:text-secondary transition-colors border-2 border-transparent hover:border-secondary px-2 py-1"
            title="Filtros avanzados"
          >
            <span className="material-symbols-outlined">tune</span>
          </button>
          <div className="flex items-center gap-2 border-l-2 border-outline-variant pl-4">
            <span className="text-primary font-bold text-xs">[</span>
            <span className="text-xs text-secondary font-bold">{elapsedLabel}</span>
            <span className="text-primary font-bold text-xs">]</span>
          </div>
        </div>
      </header>

      {showFilters && (
        <div className="bg-surface-container-low border-b border-outline-variant/15 px-8 py-4">
          <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-5 gap-4">
            <SelectField
              label="Usuario"
              value={filters.user}
              onChange={(value) => onChange({ user: value })}
              options={[
                { value: "", label: "Todos los usuarios" },
                ...users.map((user) => ({
                  value: user.user_id,
                  label: `${user.user_id} (${user.count})`,
                })),
              ]}
            />
            <FilterField
              label="Autor"
              value={filters.author}
              onChange={(value) => onChange({ author: value })}
              placeholder="@handle"
            />
            <FilterField
              label="Dominio"
              value={filters.domain}
              onChange={(value) => onChange({ domain: value })}
              placeholder="host.com"
            />
            <FilterField
              label="Desde"
              type="date"
              value={filters.from}
              onChange={(value) => onChange({ from: value })}
            />
            <FilterField
              label="Hasta"
              type="date"
              value={filters.to}
              onChange={(value) => onChange({ to: value })}
            />
          </div>
          <div className="max-w-6xl mx-auto mt-4 flex flex-wrap gap-3 md:hidden">
            <ModeButton
              label="Hibrida"
              active={filters.mode === "hybrid"}
              onClick={() => onChange({ mode: "hybrid" })}
            />
            <ModeButton
              label="Objetivo"
              active={filters.mode === "goal"}
              onClick={() => onChange({ mode: "goal", kind: "", sort: "" })}
            />
          </div>
        </div>
      )}
    </>
  );
}

function ModeButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors border-2 ${
        active
          ? "bg-primary text-on-primary border-primary"
          : "border-transparent text-on-surface-variant hover:text-secondary hover:border-secondary"
      }`}
    >
      {label}
    </button>
  );
}

function FilterField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full bg-surface-container-lowest border-2 border-outline-variant focus:border-primary focus:ring-0 text-sm px-3 py-2 font-mono"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full bg-surface-container-lowest border-2 border-outline-variant focus:border-primary focus:ring-0 text-sm px-3 py-2 font-mono"
      >
        {options.map((option) => (
          <option key={`${label}-${option.value || "all"}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function DiscoveryHome({
  corpus,
  users,
  error,
  onPick,
}: {
  corpus: { items: SearchItem[]; total: number } | null;
  users: UserSummary[];
  error: string | null;
  onPick: (patch: Partial<Filters>) => void;
}) {
  if (error) {
    return (
      <section className="relative w-full min-h-full">
        <div className="relative z-10 w-full max-w-4xl mx-auto pt-24 px-6 text-center">
          <span className="material-symbols-outlined text-4xl text-error">error</span>
          <p className="mt-4 text-sm text-on-surface-variant">
            No se pudo cargar el archivo de marcadores: {error}
          </p>
        </div>
      </section>
    );
  }

  if (!corpus) {
    return (
      <section className="relative w-full min-h-full">
        <div className="relative z-10 w-full max-w-4xl mx-auto pt-24 px-6 text-center">
          <span className="material-symbols-outlined text-4xl text-on-surface-variant animate-pulse">
            hourglass_top
          </span>
          <p className="mt-4 text-on-surface-variant text-sm">Cargando tu grafo...</p>
        </div>
      </section>
    );
  }

  const authors = [...extractAllAuthors(corpus.items).values()].sort(
    (a, b) => b.count - a.count
  );
  const domains = [...extractDomains(corpus.items).entries()].sort(
    (a, b) => b[1] - a[1]
  );
  const repos = [...extractGithubRepos(corpus.items).values()].sort(
    (a, b) => b.count - a.count
  );

  return (
    <section className="relative w-full min-h-full">
      <div className="absolute inset-0 pointer-events-none opacity-10 bg-[radial-gradient(circle_at_50%_50%,_#22d3ee_0%,_transparent_70%)]" />
      <div className="relative z-10 w-full max-w-5xl mx-auto pt-12 pb-20 px-6">
        <div className="flex flex-col items-center gap-6 mb-10">
          <div className="terminal-panel px-5 py-2 text-left w-full max-w-2xl">
            <p className="text-xs text-secondary font-bold">
              <span className="text-primary">[user@arch ~]</span>$ cat knowledge.archive
            </p>
          </div>
          <h1 className="font-headline text-3xl md:text-4xl font-bold tracking-tight text-center text-primary">
            <span className="text-secondary">&gt;</span> Explora tu archivo<span className="caret-blink"></span>
          </h1>
          <p className="text-on-surface-variant text-center max-w-xl text-sm">
            Usa <span className="text-primary font-bold">hibrida</span> para recuperar con precision o cambia a{" "}
            <span className="text-secondary font-bold">objetivo</span> para buscar por el resultado que quieres lograr.
          </p>
          <div className="flex items-center gap-3 border-2 border-primary bg-surface-container-low px-4 py-2 neo-shadow-purple-sm">
            <div className="w-2 h-2 bg-primary animate-pulse" />
            <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-on-surface-variant">
              <span className="text-primary">{corpus.items.length}</span>/{corpus.total} •{" "}
              <span className="text-secondary">{authors.length}</span> autores •{" "}
              <span className="text-secondary">{repos.length}</span> repos •{" "}
              <span className="text-secondary">{users.length}</span> usuarios
            </span>
          </div>
        </div>

        {users.length > 0 && (
          <div className="mb-12">
            <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
              <h3 className="font-headline font-bold text-lg text-on-surface flex items-center gap-2">
                <span className="material-symbols-outlined text-primary">badge</span>
                Usuarios de la base
              </h3>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {users.slice(0, 8).map((user) => (
                <button
                  key={user.user_id}
                  onClick={() => onPick({ mode: "hybrid", user: user.user_id })}
                  className="glass-card p-4 rounded-xl flex flex-col items-start gap-1 border border-outline-variant/10 cursor-pointer hover:border-primary/40 hover:scale-[1.02] transition-all text-left"
                >
                  <span className="text-primary font-bold font-headline text-sm truncate w-full">
                    {user.user_id}
                  </span>
                  <span className="text-[10px] text-on-surface-variant uppercase tracking-widest">
                    {user.count} marcador{user.count === 1 ? "" : "es"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-12">
          {authors.slice(0, 8).map((author) => (
            <button
              key={author.handle || author.name}
              onClick={() =>
                onPick({ mode: "hybrid", author: author.handle || author.name })
              }
              className="glass-card bubble-glow p-4 rounded-xl flex flex-col items-start gap-1 border border-outline-variant/10 cursor-pointer hover:border-primary/40 hover:scale-[1.02] transition-all text-left"
            >
              <span className="text-primary font-bold font-headline text-sm truncate w-full">
                {author.handle ? `@${author.handle}` : author.name}
              </span>
              <span className="text-[10px] text-on-surface-variant uppercase tracking-widest">
                {author.count} elemento{author.count === 1 ? "" : "s"}
              </span>
            </button>
          ))}
          {domains.slice(0, 5).map(([domain, count]) => (
            <button
              key={domain}
              onClick={() => onPick({ mode: "hybrid", domain })}
              className="glass-card p-4 rounded-xl flex flex-col items-start gap-1 border border-outline-variant/10 cursor-pointer hover:border-secondary/40 hover:scale-[1.02] transition-all text-left"
            >
              <span className="text-secondary font-medium font-headline text-sm truncate w-full">
                {domain}
              </span>
              <span className="text-[10px] text-on-surface-variant uppercase tracking-widest">
                {count} marcador{count === 1 ? "" : "es"}
              </span>
            </button>
          ))}
        </div>

        {repos.length > 0 && (
          <div>
            <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
              <h3 className="font-headline font-bold text-lg text-on-surface flex items-center gap-2">
                <span className="material-symbols-outlined text-primary">hub</span>
                Referencias de GitHub
              </h3>
              <a href={withBase("/repos")} className="text-xs font-bold text-primary hover:underline">
                Ver los {repos.length} →
              </a>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {repos.slice(0, 6).map((repo) => (
                <a
                  key={`${repo.owner}/${repo.repo}`}
                  href={`https://github.com/${repo.owner}/${repo.repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="group glass-card p-4 rounded-xl border border-outline-variant/15 hover:border-primary/40 transition-all flex items-start gap-3"
                >
                  <span className="material-symbols-outlined text-primary text-lg flex-shrink-0 mt-0.5">
                    code
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-on-surface font-bold text-sm truncate group-hover:text-primary transition-colors">
                      {repo.repo}
                    </p>
                    <p className="text-on-surface-variant text-xs truncate">{repo.owner}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded">
                        {repo.count}x
                      </span>
                      {repo.sample_author && (
                        <span className="text-[10px] text-on-surface-variant truncate">
                          por {repo.sample_author}
                        </span>
                      )}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function GoalPrompt({ onPickKeywordMode }: { onPickKeywordMode: () => void }) {
  return (
    <section className="px-4 md:px-8 py-16">
      <div className="max-w-3xl mx-auto rounded-3xl border border-outline-variant/15 bg-surface-container-low p-8 text-center">
        <span className="material-symbols-outlined text-5xl text-primary">route</span>
        <h2 className="mt-4 text-3xl font-headline font-bold text-on-surface">
          Describe el resultado que quieres lograr.
        </h2>
        <p className="mt-3 text-sm text-on-surface-variant">
          El modo objetivo funciona mejor con una meta concreta, por ejemplo:
          "quiero construir un buscador con grafos".
        </p>
        <p className="mt-2 text-xs text-on-surface-variant">
          Si todavia no tienes un objetivo claro, cambia a busqueda hibrida y
          explora por palabras clave.
        </p>
        <button
          onClick={onPickKeywordMode}
          className="mt-6 rounded-full bg-primary px-5 py-2 text-sm font-bold text-on-primary transition-transform hover:scale-[1.02]"
        >
          Cambiar a busqueda hibrida
        </button>
      </div>
    </section>
  );
}

function ResultsView({
  mode,
  loading,
  error,
  response,
  strategyLabel,
  total,
  visibleItems,
  filters,
  reset,
  kindFilter,
}: {
  mode: SearchMode;
  loading: boolean;
  error: string | null;
  response: (SearchResponse & { elapsed_ms: number }) | null;
  strategyLabel: string;
  total: number;
  visibleItems: SearchItem[];
  filters: Filters;
  reset: () => void;
  kindFilter: "" | "media" | "links";
}) {
  const queryText = filters.q || "tus filtros";
  const parsedQuery = getParsedQuery(response);
  const goalResponse = getGoalResponse(response);

  const isGoal = mode === "goal" && !!goalResponse;

  // Goal mode: the pipeline is the investigation axis, so it takes the
  // full central column. Analysis (parse chips, insights, contributors,
  // filters) is demoted to a horizontal strip at the bottom.
  // Hybrid mode keeps the classic layout: list + right-rail aside.

  const header = (
    <>
      <div className="flex items-center justify-between mb-8 flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-headline font-bold text-on-surface flex items-center gap-3 flex-wrap">
            {mode === "goal" ? "Resultados por objetivo" : "Resultados de busqueda"}
            <span className="text-sm font-normal text-on-surface-variant bg-surface-container-high px-2 py-0.5 rounded-full">
              {total} encontrados
            </span>
            {filters.user && (
              <span className="text-sm font-normal text-tertiary bg-tertiary/10 px-2 py-0.5 rounded-full">
                usuario {filters.user}
              </span>
            )}
            {kindFilter && mode === "hybrid" && (
              <span className="text-sm font-normal text-secondary bg-secondary/10 px-2 py-0.5 rounded-full">
                {formatKindLabel(kindFilter)}
              </span>
            )}
          </h2>
          <p className="text-on-surface-variant text-sm mt-1">
            {total > 0
              ? mode === "goal"
                ? `Mostrando los activos de conocimiento mas relevantes para "${queryText}".`
                : `Mostrando las coincidencias mas relevantes para "${queryText}".`
              : `No encontramos resultados para "${queryText}". Prueba con terminos mas amplios.`}
          </p>
        </div>
        <div className="flex gap-2">
          <span className="flex items-center gap-2 px-3 py-1.5 bg-surface-container-high rounded-lg text-xs font-medium text-on-surface-variant">
            <span className="material-symbols-outlined text-sm">
              {mode === "goal" ? "route" : "psychology"}
            </span>
            {formatModeLabel(mode)} · {strategyLabel}
          </span>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-error-container/30 border border-error/40 mb-4">
          <div className="flex items-center gap-2 text-error mb-1">
            <span className="material-symbols-outlined">error</span>
            <strong className="font-headline">La busqueda fallo</strong>
          </div>
          <p className="text-sm text-on-surface-variant">{error}</p>
        </div>
      )}

      {!error && response?.warning && (
        <div className="p-4 rounded-xl bg-secondary/10 border border-secondary/30 mb-4">
          <p className="text-sm text-on-surface-variant">{response.warning}</p>
        </div>
      )}

      {loading && (
        <div className="text-center py-16 text-on-surface-variant">
          <span className="material-symbols-outlined text-4xl animate-pulse">
            psychology
          </span>
          <p className="mt-3 text-sm">Buscando y organizando resultados...</p>
        </div>
      )}

      {!loading && !error && visibleItems.length === 0 && (
        <div className="text-center py-16">
          <span className="material-symbols-outlined text-5xl text-on-surface-variant opacity-40">
            search_off
          </span>
          <h3 className="mt-4 font-headline font-bold text-on-surface">
            Sin coincidencias
          </h3>
          <p className="mt-1 text-sm text-on-surface-variant">
            Prueba palabras mas simples o elimina algun filtro.
          </p>
        </div>
      )}
    </>
  );

  if (isGoal) {
    return (
      <section className="px-4 md:px-8 py-10">
        <div className="max-w-[1600px] mx-auto space-y-8">
          <div className="space-y-6">{header}</div>

          <GoalResultsSwitcher
            response={goalResponse!}
            visibleItems={visibleItems}
          />

          {/* Bottom analysis strip: ex right-rail, now horizontal */}
          <GoalBottomAnalysis
            parsedQuery={parsedQuery}
            response={goalResponse}
            items={visibleItems}
            filters={filters}
            reset={reset}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="px-4 md:px-8 py-10">
      <div className="max-w-6xl mx-auto flex flex-col lg:flex-row gap-8 lg:gap-12">
        <div className="flex-1 space-y-6 min-w-0">
          {header}

          <div className="space-y-4">
            {visibleItems.map((item, index) => (
              <ResultCard
                key={item.asset_id || item.id || item.tweet_id || index}
                item={item}
                anchorId={buildResultAnchorId(item) || undefined}
              />
            ))}
          </div>
        </div>

        <aside className="w-full lg:w-80 space-y-6 flex-shrink-0">
          <ParseChips pq={parsedQuery} />
          <Contributors items={visibleItems} />
          <ActiveFiltersCard filters={filters} reset={reset} />
        </aside>
      </div>
    </section>
  );
}

function GoalBottomAnalysis({
  parsedQuery,
  response,
  items,
  filters,
  reset,
}: {
  parsedQuery?: ParsedQuery;
  response: GoalSearchResponse | null;
  items: SearchItem[];
  filters: Filters;
  reset: () => void;
}) {
  return (
    <section
      aria-label="Análisis de la consulta"
      className="rounded-2xl border-2 border-outline-variant/20 bg-surface-container-lowest p-4 md:p-5"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-mono uppercase tracking-wider text-on-surface-variant">
          $ analysis --compact
        </h3>
        <span className="text-[10px] text-on-surface-variant opacity-60">
          Franja secundaria
        </span>
      </div>
      <div className="grid gap-4 lg:grid-cols-4">
        <ParseChips pq={parsedQuery} compact />
        <GoalInsights response={response} compact />
        <Contributors items={items} compact />
        <ActiveFiltersCard filters={filters} reset={reset} compact />
      </div>
    </section>
  );
}

function ParseChips({
  pq,
  compact = false,
}: {
  pq?: ParsedQuery;
  compact?: boolean;
}) {
  const panelClass = compact
    ? "rounded-xl border border-outline-variant/15 bg-surface-container-low p-4"
    : "glass-panel p-6 rounded-2xl border border-outline-variant/15";
  const titleClass = compact
    ? "mb-3 text-on-surface font-headline font-bold text-xs uppercase tracking-wider"
    : "text-on-surface font-headline font-bold mb-4 text-sm uppercase tracking-wider";
  const chipsClass = compact
    ? "flex flex-wrap gap-1.5 min-h-[1.75rem]"
    : "flex flex-wrap gap-2 min-h-[2rem]";
  const chipClass = compact
    ? "px-2.5 py-0.5 border rounded-full text-[11px] font-medium"
    : "px-3 py-1 border rounded-full text-xs font-medium";

  if (!pq) {
    return (
      <section className={panelClass}>
        <h4 className={titleClass}>
          Analisis de consulta
        </h4>
        <span className="text-xs text-on-surface-variant opacity-50">
          Sin terminos detectados.
        </span>
      </section>
    );
  }

  const chips: { label: string; cls: string }[] = [];
  (pq.terms || []).forEach((term) =>
    chips.push({ label: term, cls: "bg-primary/10 border-primary/30 text-primary" })
  );
  (pq.phrases || []).forEach((phrase) =>
    chips.push({
      label: `"${phrase}"`,
      cls: "bg-secondary/10 border-secondary/30 text-secondary",
    })
  );
  (pq.exclude || []).forEach((term) =>
    chips.push({ label: term, cls: "bg-error/10 border-error/30 text-error line-through" })
  );

  const parsedFilters = pq.filters || {};
  if (parsedFilters.author) {
    chips.push({
      label: `autor:${parsedFilters.author}`,
      cls: "bg-tertiary/10 border-tertiary/30 text-tertiary",
    });
  }
  if (parsedFilters.domain) {
    chips.push({
      label: `dominio:${parsedFilters.domain}`,
      cls: "bg-tertiary/10 border-tertiary/30 text-tertiary",
    });
  }

  return (
    <section className={panelClass}>
      <h4 className={titleClass}>
        Analisis de consulta
      </h4>
      <div className={chipsClass}>
        {chips.length === 0 ? (
          <span className="text-xs text-on-surface-variant opacity-50">
            Sin terminos detectados.
          </span>
        ) : (
          chips.map((chip, index) => (
            <span
              key={`${chip.label}-${index}`}
              className={`${chipClass} ${chip.cls}`}
            >
              {chip.label}
            </span>
          ))
        )}
      </div>
    </section>
  );
}

function GoalInsights({
  response,
  compact = false,
}: {
  response: GoalSearchResponse | null;
  compact?: boolean;
}) {
  if (
    !response?.goal_parse &&
    !response?.steps?.length &&
    !response?.next_steps?.length
  ) {
    return null;
  }

  const STEP_LABELS: Record<string, string> = {
    data_extraction: "Extraccion",
    data_enrichment: "Enriquecimiento",
    storage: "Almacenamiento",
    api_layer: "API",
    search_layer: "Busqueda",
    ai_reasoning: "IA / LLM",
    workflow: "Automatizacion",
    outreach: "Outreach",
    visualization: "Dashboard",
    auth_layer: "Auth",
    deployment: "Deploy",
  };

  const pathSteps = (response.steps || []).slice(0, compact ? 4 : 6);
  const sectionClass = compact
    ? "rounded-xl border border-outline-variant/15 bg-surface-container-low p-4"
    : "p-6 rounded-2xl bg-surface-container-low";
  const titleClass = compact
    ? "text-on-surface font-headline font-bold mb-3 text-xs uppercase tracking-wider"
    : "text-on-surface font-headline font-bold mb-4 text-sm uppercase tracking-wider";
  const componentClass = compact
    ? "rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
    : "rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary";
  const pathTagClass = compact
    ? "inline-flex items-center gap-1 rounded border border-secondary/40 bg-secondary/10 px-2 py-0.5 font-mono text-[10px] text-secondary"
    : "inline-flex items-center gap-1 rounded border-2 border-secondary bg-secondary/10 px-2 py-0.5 font-mono text-secondary";

  return (
    <section className={sectionClass}>
      <h4 className={titleClass}>
        Claves del objetivo
      </h4>
      {response.goal_parse?.intent && (
        <p className="text-xs text-on-surface-variant mb-3">
          Intencion:{" "}
          <span className="text-on-surface font-semibold">
            {formatIntentLabel(response.goal_parse.intent)}
          </span>
        </p>
      )}
      {!!response.goal_parse?.required_components?.length && (
        <div className="mb-4 flex flex-wrap gap-2">
          {response.goal_parse.required_components.map((component) => (
            <span key={component} className={componentClass}>
              {component}
            </span>
          ))}
        </div>
      )}
      {pathSteps.length > 0 && (
        <div className="mb-4">
          <p className="text-[10px] font-mono uppercase tracking-wider text-on-surface-variant mb-2">
            $ path --compose
          </p>
          <ol className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {pathSteps.map((step, idx) => (
              <li key={step.step} className="flex items-center gap-1.5">
                {idx > 0 && (
                  <span className="text-on-surface-variant font-mono">&rarr;</span>
                )}
                <span
                  className={pathTagClass}
                  title={`${step.step} · tokens: ${(step.contributing_tokens || []).join(", ")}`}
                >
                  <span className="font-bold">
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <span>{STEP_LABELS[step.step] || step.step}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {!!response.next_steps?.length && (
        <div className="space-y-2">
          {response.next_steps.map((step) => (
            <p key={step} className="text-xs text-on-surface-variant leading-relaxed">
              {translateNextStep(step)}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

function GoalResultsSwitcher({
  response,
  visibleItems,
}: {
  response: GoalSearchResponse;
  visibleItems: SearchItem[];
}) {
  const [view, setView] = useState<"pipeline" | "list">("pipeline");

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border-2 border-outline-variant/25 bg-surface-container-low p-0.5 text-xs font-mono">
        <button
          type="button"
          onClick={() => setView("pipeline")}
          className={`px-3 py-1 rounded-md transition-colors ${
            view === "pipeline"
              ? "bg-primary text-on-primary font-bold"
              : "text-on-surface-variant hover:text-on-surface"
          }`}
        >
          ~/ pipeline
        </button>
        <button
          type="button"
          onClick={() => setView("list")}
          className={`px-3 py-1 rounded-md transition-colors ${
            view === "list"
              ? "bg-primary text-on-primary font-bold"
              : "text-on-surface-variant hover:text-on-surface"
          }`}
        >
          $ list
        </button>
      </div>

      {view === "pipeline" ? (
        <GoalPipelineView response={response} />
      ) : (
        <div className="space-y-4">
          {visibleItems.map((item, index) => (
            <ResultCard
              key={item.asset_id || item.id || item.tweet_id || index}
              item={item}
              anchorId={buildResultAnchorId(item) || undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GoalGroups({
  groupedResults,
}: {
  groupedResults: GoalSearchResponse["grouped_results"];
}) {
  const sections = [
    {
      key: "repos",
      label: "Repos",
      eyebrow: "Paso 1",
      description: "Base tecnica para arrancar y validar el camino principal.",
      items: groupedResults?.repos || [],
    },
    {
      key: "tools",
      label: "Herramientas",
      eyebrow: "Paso 2",
      description: "Piezas para ejecutar, acelerar o automatizar el objetivo.",
      items: groupedResults?.tools || [],
    },
    {
      key: "tutorials",
      label: "Tutoriales",
      eyebrow: "Paso 3",
      description: "Guias para convertir la idea en una secuencia de trabajo.",
      items: groupedResults?.tutorials || [],
    },
    {
      key: "examples",
      label: "Ejemplos",
      eyebrow: "Paso 4",
      description: "Referencias concretas para contrastar implementaciones.",
      items: groupedResults?.examples || [],
    },
  ].filter((section) => section.items.length > 0);

  if (sections.length === 0) return null;

  return (
    <section className="rounded-2xl border border-outline-variant/15 bg-surface-container-low p-6">
      <div className="mb-4 flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">hub</span>
        <h3 className="font-headline text-lg font-bold text-on-surface">
          Desglose del objetivo
        </h3>
      </div>
      <p className="mb-5 text-sm leading-relaxed text-on-surface-variant">
        Esta secuencia resume por donde conviene empezar, que abrir despues y en que
        resultado conviene profundizar.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {sections.map((section) => (
          <div
            key={section.key}
            className="rounded-xl border border-outline-variant/15 bg-surface-container-lowest p-4"
          >
            <div className="mb-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-primary">
                {section.eyebrow}
              </p>
              <h4 className="mt-1 text-sm font-bold uppercase tracking-wider text-on-surface">
                {section.label}
              </h4>
              <p className="mt-1 text-xs leading-relaxed text-on-surface-variant">
                {section.description}
              </p>
            </div>
            <div className="space-y-3">
              {section.items.slice(0, 3).map((item, index) => (
                <GoalSequenceCard
                  key={`${section.key}-${item.asset_id || item.id || item.tweet_id || index}`}
                  item={item}
                  sectionKey={section.key}
                  stepLabel={`${section.eyebrow}.${index + 1}`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function GoalSequenceCard({
  item,
  sectionKey,
  stepLabel,
}: {
  item: SearchItem;
  sectionKey: string;
  stepLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [reposOpen, setReposOpen] = useState(false);
  const title = getGoalCardTitle(item);
  const preview = getGoalCardPreview(item);
  const primaryUrl = getGoalPrimaryUrl(item);
  const detailAnchor = buildResultAnchorId(item);
  const author = item.author_name || item.author_username || "Fuente sin autor";
  const date = formatDate(item.created_at);
  const domain = item.source_domain || safeDomain(primaryUrl);
  const difficulty = formatGoalDifficulty(item.difficulty);
  const assetType = formatGoalAssetType(getDisplayAssetType(item));
  const relatedLinks = extractContextLinks(item, primaryUrl).slice(0, 4);
  const repos = [...extractGithubRepos([item]).values()];
  const readmeCount = new Set(
    (item.github_readmes || [])
      .map((readme) => String(readme.repo_slug || "").toLowerCase())
      .filter(Boolean)
  ).size;
  const suggestion = buildGoalSuggestion(sectionKey, item);
  const primaryCtaLabel =
    primaryUrl && isGithubRepoUrl(primaryUrl) ? "Abrir repo" : "Abrir post";
  const hasExpandableContent =
    preview.length > 180 ||
    relatedLinks.length > 0 ||
    repos.length > 0 ||
    (item.topics || []).length > 0 ||
    (item.required_components || []).length > 0;

  return (
    <article className="rounded-xl border border-outline-variant/15 bg-surface-container-low p-4 transition-colors hover:border-primary/35">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="inline-flex rounded-full bg-primary/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
            {stepLabel}
          </span>
          <h5 className="mt-2 text-sm font-semibold leading-snug text-on-surface">
            {title}
          </h5>
        </div>
        {typeof item.score === "number" && item.score > 0 && (
          <span className="flex-shrink-0 rounded-full bg-primary/10 px-2 py-1 text-[11px] font-bold text-primary">
            {item.score.toFixed(3)}
          </span>
        )}
      </div>

      <div className="mb-3 flex flex-wrap gap-2 text-[11px] text-on-surface-variant">
        <span className="rounded-full bg-surface-container-high px-2.5 py-1">
          {assetType}
        </span>
        {difficulty && (
          <span className="rounded-full bg-surface-container-high px-2.5 py-1">
            {difficulty}
          </span>
        )}
        {domain && (
          <span className="rounded-full bg-surface-container-high px-2.5 py-1">
            {domain}
          </span>
        )}
      </div>

      <p
        className={`text-sm leading-relaxed text-on-surface-variant ${
          !expanded ? "line-clamp-4" : ""
        }`}
      >
        {preview}
      </p>

      <p className="mt-3 rounded-xl border border-primary/15 bg-primary/5 px-3 py-2 text-xs leading-relaxed text-on-surface">
        <span className="font-semibold text-primary">Sugerencia:</span> {suggestion}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-on-surface-variant">
        <span>{author}</span>
        <span aria-hidden="true">•</span>
        <span>{date}</span>
      </div>

      {item.why_this_result && item.why_this_result.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {item.why_this_result.slice(0, expanded ? 4 : 2).map((reason) => (
            <span
              key={reason}
              className="rounded-full border border-secondary/20 bg-secondary/8 px-2 py-0.5 text-[11px] text-secondary"
            >
              {reason.replace(/^asset_type:/, "tipo:")}
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="mt-4 space-y-3">
          {!!item.required_components?.length && (
            <div className="flex flex-wrap gap-1.5">
              {item.required_components.slice(0, 4).map((component) => (
                <span
                  key={component}
                  className="rounded-full border border-primary/20 bg-primary/8 px-2 py-0.5 text-[11px] text-primary"
                >
                  {component}
                </span>
              ))}
            </div>
          )}

          {!!item.topics?.length && (
            <div className="flex flex-wrap gap-1.5">
              {item.topics.slice(0, 4).map((topic) => (
                <span
                  key={topic}
                  className="rounded-full bg-surface-container-high px-2 py-0.5 text-[11px] text-on-surface-variant"
                >
                  {topic}
                </span>
              ))}
            </div>
          )}

          {relatedLinks.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
                Detalles
              </p>
              {relatedLinks.map((link) => (
                <a
                  key={link}
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-xs text-secondary hover:underline"
                >
                  {link}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {primaryUrl && (
          <a
            href={primaryUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary hover:brightness-110"
          >
            {primaryCtaLabel}
            <span className="material-symbols-outlined text-sm">arrow_outward</span>
          </a>
        )}
        {detailAnchor && (
          <a
            href={`#${detailAnchor}`}
            className="inline-flex items-center gap-1 rounded-lg border border-outline-variant/25 bg-surface-container-high px-3 py-2 text-xs font-semibold text-on-surface hover:border-primary/35 hover:text-primary"
          >
            Ver detalle
            <span className="material-symbols-outlined text-sm">south</span>
          </a>
        )}
        {repos.length > 0 && (
          <button
            type="button"
            onClick={() => setReposOpen(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-primary/25 bg-primary/8 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/12"
          >
            Ver {repos.length} repo{repos.length === 1 ? "" : "s"}
            {readmeCount > 0 ? ` | ${readmeCount} README` : ""}
            <span className="material-symbols-outlined text-sm">hub</span>
          </button>
        )}
        {hasExpandableContent && (
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1 rounded-lg border border-outline-variant/20 px-3 py-2 text-xs font-semibold text-on-surface-variant hover:text-on-surface"
          >
            {expanded ? "Mostrar menos" : "Expandir card"}
            <span className="material-symbols-outlined text-sm">
              {expanded ? "expand_less" : "expand_more"}
            </span>
          </button>
        )}
      </div>

      {reposOpen && (
        <MentionedReposModal
          item={item}
          onClose={() => setReposOpen(false)}
        />
      )}
    </article>
  );
}

function Contributors({
  items,
  compact = false,
}: {
  items: SearchItem[];
  compact?: boolean;
}) {
  const authors = [...extractAllAuthors(items).values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, compact ? 4 : 5);
  const sectionClass = compact
    ? "rounded-xl border border-outline-variant/15 bg-surface-container-low p-4"
    : "p-6 rounded-2xl bg-surface-container-low";
  const titleClass = compact
    ? "text-on-surface font-headline font-bold mb-3 text-xs uppercase tracking-wider"
    : "text-on-surface font-headline font-bold mb-4 text-sm uppercase tracking-wider";
  const listClass = compact ? "space-y-2" : "space-y-3";
  const badgeClass = compact
    ? "text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded flex-shrink-0"
    : "text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded flex-shrink-0";

  return (
    <section className={sectionClass}>
      <h4 className={titleClass}>
        Principales autores
      </h4>
      {authors.length === 0 ? (
        <p className="text-xs text-on-surface-variant opacity-50">
          Ejecuta una busqueda para ver autores destacados.
        </p>
      ) : (
        <div className={listClass}>
          {authors.map((author) => (
            <div key={author.handle || author.name} className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`rounded bg-surface-container-highest flex items-center justify-center flex-shrink-0 ${
                    compact ? "h-7 w-7" : "w-8 h-8"
                  }`}
                >
                  <span className="text-[10px] font-bold text-primary">
                    {(author.name[0] || "?").toUpperCase()}
                  </span>
                </div>
                <span className="text-xs font-medium truncate">{author.name}</span>
              </div>
              <span className={badgeClass}>
                {author.count}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ActiveFiltersCard({
  filters,
  reset,
  compact = false,
}: {
  filters: Filters;
  reset: () => void;
  compact?: boolean;
}) {
  const entries: [string, string][] = [["Modo", formatModeLabel(filters.mode)]];
  if (filters.user) entries.push(["Usuario", filters.user]);
  if (filters.author) entries.push(["Autor", filters.author]);
  if (filters.domain) entries.push(["Dominio", filters.domain]);
  if (filters.from) entries.push(["Desde", filters.from]);
  if (filters.to) entries.push(["Hasta", filters.to]);
  if (filters.kind && filters.mode === "hybrid") {
    entries.push(["Tipo", formatKindLabel(filters.kind)]);
  }
  if (filters.sort && filters.mode === "hybrid") {
    entries.push(["Orden", filters.sort === "recent" ? "recientes" : filters.sort]);
  }
  if (entries.length === 0) return null;
  const wrapperClass = compact
    ? "rounded-xl border border-secondary/35 bg-surface-container-low p-4"
    : "p-5 bg-surface-container-low border-2 border-secondary neo-shadow-purple";
  const titleClass = compact
    ? "font-headline font-bold mb-3 text-secondary uppercase tracking-wider text-xs"
    : "font-headline font-bold mb-3 text-secondary uppercase tracking-wider text-sm";
  const contentClass = compact
    ? "text-xs mb-3 leading-relaxed space-y-1 font-mono"
    : "text-xs mb-4 leading-relaxed space-y-1 font-mono";
  const buttonClass = compact
    ? "w-full rounded-lg py-2 bg-primary text-on-primary font-bold text-[11px] uppercase tracking-widest hover:bg-secondary transition-colors"
    : "w-full py-2 bg-primary text-on-primary border-2 border-primary font-bold text-xs uppercase tracking-widest hover:bg-secondary hover:border-secondary transition-colors";

  return (
    <div className={wrapperClass}>
      <h4 className={titleClass}>
        <span className="text-primary">&gt;</span> filtros activos
      </h4>
      <div className={contentClass}>
        {entries.map(([label, value]) => (
          <div key={label}>
            <span className="text-primary font-bold">{label}:</span>{" "}
            <span className="text-on-surface">{value}</span>
          </div>
        ))}
      </div>
      <button onClick={reset} className={buttonClass}>
        $ reset --all
      </button>
    </div>
  );
}
