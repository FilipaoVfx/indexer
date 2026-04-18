/**
 * SearchApp - experiencia de busqueda hibrida + busqueda por objetivo.
 * Conserva la exploracion de marcadores y conecta el flujo goal search a Supabase.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyBookmarkView } from "../lib/bookmark-view";
import {
  extractAllAuthors,
  extractDomains,
  extractGithubRepos,
  getCorpus,
  searchGoal,
  searchHybrid,
  type GoalSearchResponse,
  type ParsedQuery,
  type SearchItem,
  type SearchResponse,
  type SearchMode,
} from "../lib/api";
import {
  type Filters,
  hasAnySearchInput,
  hasRemoteSearchInput,
  useFilters,
  withBase,
} from "../lib/url-state";
import ResultCard from "./ResultCard";

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
    if (remoteSearch || showGoalPrompt) return;

    let mounted = true;
    setCorpusError(null);
    getCorpus()
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
  }, [remoteSearch, showGoalPrompt]);

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

  return (
    <>
      <Header
        filters={filters}
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
  onChange: (patch: Partial<Filters>) => void;
  onSubmit: () => void;
  showFilters: boolean;
  setShowFilters: (value: boolean) => void;
  elapsedLabel: string;
}

function Header({
  filters,
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
      <header className="bg-[#0b1326] backdrop-blur-xl bg-opacity-80 flex justify-between items-center w-full px-8 h-20 z-50 border-b border-outline-variant/15">
        <div className="flex items-center gap-8 flex-1 min-w-0">
          <span className="text-xl font-bold text-[#c0c1ff] font-headline tracking-tight hidden lg:block">
            Consola de conocimiento
          </span>
          <div className="hidden md:flex items-center gap-2 rounded-full border border-outline-variant/20 bg-surface-container-low px-1 py-1">
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
            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant">
              {filters.mode === "goal" ? "route" : "search"}
            </span>
            <input
              value={filters.q}
              onChange={(event) => onChange({ q: event.target.value })}
              type="text"
              autoComplete="off"
              placeholder={placeholder}
              className="w-full bg-surface-container-lowest border-none focus:ring-2 focus:ring-primary pl-12 pr-4 py-2.5 rounded-lg text-on-surface text-sm transition-all"
            />
          </form>
        </div>
        <div className="flex items-center gap-6 ml-6">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="text-on-surface-variant hover:text-primary transition-colors"
            title="Filtros avanzados"
          >
            <span className="material-symbols-outlined">tune</span>
          </button>
          <div className="flex items-center gap-2 border-l border-outline-variant/15 pl-6">
            <span className="material-symbols-outlined text-on-surface-variant">
              bolt
            </span>
            <span className="text-xs text-on-surface-variant">{elapsedLabel}</span>
          </div>
        </div>
      </header>

      {showFilters && (
        <div className="bg-surface-container-low border-b border-outline-variant/15 px-8 py-4">
          <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-4">
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
      className={`rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors ${
        active
          ? "bg-primary text-on-primary"
          : "text-on-surface-variant hover:text-on-surface"
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
        className="mt-1 w-full bg-surface-container-lowest border-none rounded-md text-sm px-3 py-2 focus:ring-2 focus:ring-primary"
      />
    </label>
  );
}

function DiscoveryHome({
  corpus,
  error,
  onPick,
}: {
  corpus: { items: SearchItem[]; total: number } | null;
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
      <div className="absolute inset-0 pointer-events-none opacity-20 bg-[radial-gradient(circle_at_50%_50%,_#4b4dd8_0%,_transparent_70%)]" />
      <div className="relative z-10 w-full max-w-5xl mx-auto pt-12 pb-20 px-6">
        <div className="flex flex-col items-center gap-6 mb-10">
          <h1 className="font-headline text-4xl md:text-5xl font-bold tracking-tight text-center text-on-surface">
            Explora tu archivo de conocimiento.
          </h1>
          <p className="text-on-surface-variant text-center max-w-xl">
            Usa la busqueda hibrida para recuperar con precision o cambia a Objetivo
            para buscar por el resultado que quieres lograr.
          </p>
          <div className="flex items-center gap-3 glass-card px-4 py-2 rounded-full border border-outline-variant/20">
            <div className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
            <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-on-surface-variant">
              {corpus.items.length} cargados / {corpus.total} total • {authors.length}{" "}
              autores • {repos.length} repos
            </span>
          </div>
        </div>

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

  return (
    <section className="px-4 md:px-8 py-10">
      <div className="max-w-6xl mx-auto flex flex-col lg:flex-row gap-8 lg:gap-12">
        <div className="flex-1 space-y-6 min-w-0">
          <div className="flex items-center justify-between mb-8 flex-wrap gap-3">
            <div>
              <h2 className="text-2xl font-headline font-bold text-on-surface flex items-center gap-3 flex-wrap">
                {mode === "goal" ? "Resultados por objetivo" : "Resultados de busqueda"}
                <span className="text-sm font-normal text-on-surface-variant bg-surface-container-high px-2 py-0.5 rounded-full">
                  {total} encontrados
                </span>
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

          {goalResponse?.grouped_results && (
            <GoalGroups groupedResults={goalResponse.grouped_results} />
          )}

          <div className="space-y-4">
            {visibleItems.map((item, index) => (
              <ResultCard
                key={item.asset_id || item.id || item.tweet_id || index}
                item={item}
              />
            ))}
          </div>
        </div>

        <aside className="w-full lg:w-80 space-y-6 flex-shrink-0">
          <ParseChips pq={parsedQuery} />
          <GoalInsights response={goalResponse} />
          <Contributors items={visibleItems} />
          <ActiveFiltersCard filters={filters} reset={reset} />
        </aside>
      </div>
    </section>
  );
}

function ParseChips({ pq }: { pq?: ParsedQuery }) {
  if (!pq) {
    return (
      <section className="glass-panel p-6 rounded-2xl border border-outline-variant/15">
        <h4 className="text-on-surface font-headline font-bold mb-4 text-sm uppercase tracking-wider">
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
    <section className="glass-panel p-6 rounded-2xl border border-outline-variant/15">
      <h4 className="text-on-surface font-headline font-bold mb-4 text-sm uppercase tracking-wider">
        Analisis de consulta
      </h4>
      <div className="flex flex-wrap gap-2 min-h-[2rem]">
        {chips.length === 0 ? (
          <span className="text-xs text-on-surface-variant opacity-50">
            Sin terminos detectados.
          </span>
        ) : (
          chips.map((chip, index) => (
            <span
              key={`${chip.label}-${index}`}
              className={`px-3 py-1 border rounded-full text-xs font-medium ${chip.cls}`}
            >
              {chip.label}
            </span>
          ))
        )}
      </div>
    </section>
  );
}

function GoalInsights({ response }: { response: GoalSearchResponse | null }) {
  if (!response?.goal_parse && !response?.next_steps?.length) {
    return null;
  }

  return (
    <section className="p-6 rounded-2xl bg-surface-container-low">
      <h4 className="text-on-surface font-headline font-bold mb-4 text-sm uppercase tracking-wider">
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
            <span
              key={component}
              className="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary"
            >
              {component}
            </span>
          ))}
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

function GoalGroups({
  groupedResults,
}: {
  groupedResults: GoalSearchResponse["grouped_results"];
}) {
  const sections = [
    { key: "repos", label: "Repos", items: groupedResults?.repos || [] },
    { key: "tools", label: "Herramientas", items: groupedResults?.tools || [] },
    { key: "tutorials", label: "Tutoriales", items: groupedResults?.tutorials || [] },
    { key: "examples", label: "Ejemplos", items: groupedResults?.examples || [] },
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
      <div className="grid gap-4 md:grid-cols-2">
        {sections.map((section) => (
          <div key={section.key} className="rounded-xl bg-surface-container-lowest p-4">
            <h4 className="mb-2 text-sm font-bold uppercase tracking-wider text-on-surface">
              {section.label}
            </h4>
            <div className="space-y-2">
              {section.items.slice(0, 3).map((item) => (
                <div key={item.asset_id || item.id || item.tweet_id} className="text-sm">
                  <p className="font-medium text-on-surface line-clamp-2">
                    {item.title || item.summary || item.text_content}
                  </p>
                  {typeof item.score === "number" && (
                    <p className="text-xs text-on-surface-variant">
                      puntaje {item.score.toFixed(3)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Contributors({ items }: { items: SearchItem[] }) {
  const authors = [...extractAllAuthors(items).values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return (
    <section className="p-6 rounded-2xl bg-surface-container-low">
      <h4 className="text-on-surface font-headline font-bold mb-4 text-sm uppercase tracking-wider">
        Principales autores
      </h4>
      {authors.length === 0 ? (
        <p className="text-xs text-on-surface-variant opacity-50">
          Ejecuta una busqueda para ver autores destacados.
        </p>
      ) : (
        <div className="space-y-3">
          {authors.map((author) => (
            <div key={author.handle || author.name} className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded bg-surface-container-highest flex items-center justify-center flex-shrink-0">
                  <span className="text-[10px] font-bold text-primary">
                    {(author.name[0] || "?").toUpperCase()}
                  </span>
                </div>
                <span className="text-xs font-medium truncate">{author.name}</span>
              </div>
              <span className="text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded flex-shrink-0">
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
}: {
  filters: Filters;
  reset: () => void;
}) {
  const entries: [string, string][] = [["Modo", formatModeLabel(filters.mode)]];
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

  return (
    <div className="p-6 rounded-2xl bg-gradient-to-br from-primary-container to-tertiary-container text-on-primary shadow-xl">
      <h4 className="font-headline font-bold mb-2">Filtros activos</h4>
      <div className="text-sm opacity-90 mb-4 leading-relaxed space-y-1">
        {entries.map(([label, value]) => (
          <div key={label}>
            <span className="font-bold">{label}:</span> {value}
          </div>
        ))}
      </div>
      <button
        onClick={reset}
        className="w-full py-2 bg-on-primary text-primary font-bold rounded text-xs uppercase tracking-widest hover:bg-white transition-colors"
      >
        Limpiar filtros
      </button>
    </div>
  );
}
