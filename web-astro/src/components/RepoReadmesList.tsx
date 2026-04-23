import { useEffect, useMemo, useState } from "react";
import {
  fetchGithubReadmes,
  fetchUsers,
  formatDate,
  type GithubReadme,
  type RepoClassification,
  type UserSummary,
} from "../lib/api";

interface ViewState {
  q: string;
  repo: string;
  user: string;
}

function readState(): ViewState {
  if (typeof window === "undefined") {
    return { q: "", repo: "", user: "" };
  }

  const params = new URLSearchParams(window.location.search);
  return {
    q: params.get("q") || "",
    repo: params.get("repo") || "",
    user: params.get("user") || "",
  };
}

function writeState(state: ViewState) {
  if (typeof window === "undefined") return;

  const params = new URLSearchParams();
  if (state.q.trim()) params.set("q", state.q.trim());
  if (state.repo.trim()) params.set("repo", state.repo.trim());
  if (state.user.trim()) params.set("user", state.user.trim());

  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`
  );
}

function statusLabel(readme: GithubReadme): string {
  if (readme.status === "ok") return "README listo";
  if (readme.status === "not_found") return "README no encontrado";
  if (readme.status === "pending") return "Pendiente";
  return "Error";
}

function formatBytes(value?: number | null): string {
  const size = Number(value || 0);
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatClassifierLabel(value?: string | null): string {
  return String(value || "")
    .replace(/_/g, " ")
    .trim();
}

function ClassifierTagGroup({
  label,
  values,
  tone = "primary",
}: {
  label: string;
  values?: string[];
  tone?: "primary" | "secondary" | "neutral";
}) {
  const items = (values || []).filter(Boolean);
  if (items.length === 0) return null;

  const className =
    tone === "secondary"
      ? "border-secondary/20 bg-secondary/8 text-secondary"
      : tone === "neutral"
      ? "border-outline-variant bg-surface-container-high text-on-surface-variant"
      : "border-primary/20 bg-primary/8 text-primary";

  return (
    <div>
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-on-surface-variant">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((value) => (
          <span
            key={`${label}-${value}`}
            className={`border px-2 py-0.5 text-[11px] ${className}`}
          >
            {formatClassifierLabel(value)}
          </span>
        ))}
      </div>
    </div>
  );
}

function ClassificationSummary({ classification }: { classification?: RepoClassification | null }) {
  if (!classification) return null;

  return (
    <section className="space-y-4 border-b-2 border-outline-variant bg-surface-container-low p-5">
      <div className="flex flex-wrap items-center gap-2">
        {classification.primary_category && (
          <span className="border-2 border-primary bg-primary/10 px-2 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
            {formatClassifierLabel(classification.primary_category)}
          </span>
        )}
        {classification.maturity && (
          <span className="border border-secondary/20 bg-secondary/8 px-2 py-1 text-[11px] text-secondary">
            madurez: {formatClassifierLabel(classification.maturity)}
          </span>
        )}
        {classification.complexity && (
          <span className="border border-outline-variant bg-surface-container-high px-2 py-1 text-[11px] text-on-surface-variant">
            complejidad: {formatClassifierLabel(classification.complexity)}
          </span>
        )}
        {typeof classification.confidence === "number" && (
          <span className="border border-outline-variant bg-surface-container-high px-2 py-1 text-[11px] text-on-surface-variant">
            confianza {(classification.confidence * 100).toFixed(0)}%
          </span>
        )}
      </div>

      <ClassifierTagGroup
        label="Categorias secundarias"
        values={classification.secondary_categories}
        tone="secondary"
      />
      <ClassifierTagGroup
        label="Capacidades"
        values={classification.capabilities}
      />
      <ClassifierTagGroup
        label="Interfaces"
        values={classification.integration_types}
        tone="secondary"
      />
      <ClassifierTagGroup
        label="Entradas"
        values={classification.input_types}
        tone="neutral"
      />
      <ClassifierTagGroup
        label="Salidas"
        values={classification.output_types}
        tone="neutral"
      />
      <ClassifierTagGroup
        label="Stack"
        values={classification.tech_stack}
        tone="secondary"
      />
      <ClassifierTagGroup
        label="Despliegue"
        values={classification.deployment_modes}
        tone="neutral"
      />
      <ClassifierTagGroup
        label="Restricciones"
        values={classification.constraints}
        tone="neutral"
      />
      <ClassifierTagGroup
        label="Dominio"
        values={classification.target_domains}
        tone="secondary"
      />
    </section>
  );
}

export default function RepoReadmesList() {
  const [view, setView] = useState<ViewState>(() => readState());
  const [items, setItems] = useState<GithubReadme[]>([]);
  const [total, setTotal] = useState(0);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchUsers()
      .then((nextUsers) => {
        if (!mounted) return;
        setUsers(nextUsers);
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
    let mounted = true;
    setLoading(true);
    setError(null);
    setWarning(null);
    writeState(view);

    fetchGithubReadmes({
      user_id: view.user || undefined,
      q: view.q || undefined,
      repo: view.repo || undefined,
      include_content: true,
      limit: 100,
    })
      .then((response) => {
        if (!mounted) return;
        setItems(response.items);
        setTotal(response.total);
        setWarning(response.warning || null);
      })
      .catch((err) => {
        if (!mounted) return;
        setItems([]);
        setTotal(0);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [view]);

  const selected = useMemo(() => {
    if (view.repo) {
      return items.find((item) => item.repo_slug === view.repo.toLowerCase()) || items[0] || null;
    }
    return items[0] || null;
  }, [items, view.repo]);

  function updateView(patch: Partial<ViewState>) {
    setView((current) => ({
      ...current,
      ...patch,
    }));
  }

  return (
    <section className="px-4 md:px-8 py-10 pb-24 md:pb-10">
      <div className="max-w-7xl mx-auto">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-secondary">
              cache temporal
            </p>
            <h2 className="mt-2 flex items-center gap-3 text-2xl font-headline font-bold text-on-surface">
              <span className="material-symbols-outlined text-primary">description</span>
              README de repos guardados
            </h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              READMEs extraidos al guardar bookmarks con repos de GitHub.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <select
              value={view.user}
              onChange={(event) => updateView({ user: event.target.value, repo: "" })}
              className="bg-surface-container-lowest border-2 border-outline-variant focus:border-primary focus:ring-0 px-3 py-2 text-sm"
            >
              <option value="">Todos los usuarios</option>
              {users.map((user) => (
                <option key={user.user_id} value={user.user_id}>
                  {user.user_id} ({user.count})
                </option>
              ))}
            </select>
            <input
              value={view.q}
              onChange={(event) => updateView({ q: event.target.value, repo: "" })}
              placeholder="Filtrar README..."
              className="w-64 bg-surface-container-lowest border-2 border-outline-variant focus:border-primary focus:ring-0 px-3 py-2 text-sm"
            />
          </div>
        </header>

        {warning && (
          <div className="mb-4 border-2 border-secondary bg-secondary/10 px-4 py-3 text-sm text-on-surface-variant">
            {warning}
          </div>
        )}

        {error && (
          <div className="mb-4 border-2 border-error bg-error-container/30 px-4 py-3 text-sm text-error">
            {error}
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-2 border-outline-variant bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant">
          <p>
            <span className="font-bold text-primary">{items.length}</span> visibles de{" "}
            <span className="font-bold text-primary">{total}</span> README.
          </p>
          {loading && <p>Cargando cache...</p>}
        </div>

        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="space-y-3 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto pr-1">
            {!loading && items.length === 0 && (
              <div className="border-2 border-outline-variant bg-surface-container-low p-5 text-sm text-on-surface-variant">
                Todavia no hay README cacheados. Se crean cuando entra un bookmark con repo GitHub.
              </div>
            )}
            {items.map((item) => {
              const active = selected?.repo_slug === item.repo_slug;
              return (
                <button
                  key={item.repo_slug}
                  type="button"
                  onClick={() => updateView({ repo: item.repo_slug })}
                  className={`block w-full border-2 p-4 text-left transition-colors ${
                    active
                      ? "border-primary bg-primary text-on-primary"
                      : "border-outline-variant bg-surface-container-low hover:border-secondary"
                  }`}
                >
                  <span className="block truncate text-sm font-bold">{item.repo_slug}</span>
                  <span
                    className={`mt-2 inline-block text-[10px] font-bold uppercase tracking-wider ${
                      active ? "text-on-primary" : "text-secondary"
                    }`}
                  >
                    {statusLabel(item)}
                  </span>
                  {item.classification?.primary_category && (
                    <span className="mt-2 block text-[11px] opacity-85">
                      {formatClassifierLabel(item.classification.primary_category)}
                    </span>
                  )}
                  <span className="mt-2 block text-xs opacity-80">
                    {item.bookmark_count || 0} bookmark(s)
                    {item.fetched_at ? ` | ${formatDate(item.fetched_at)}` : ""}
                  </span>
                </button>
              );
            })}
          </aside>

          <main className="min-w-0 border-2 border-primary bg-surface-container-lowest">
            {!selected ? (
              <div className="p-8 text-sm text-on-surface-variant">
                Selecciona un README para leerlo.
              </div>
            ) : (
              <article>
                <header className="border-b-2 border-primary bg-background p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-xl font-bold text-on-surface">
                        {selected.repo_slug}
                      </h3>
                      <p className="mt-1 text-xs text-on-surface-variant">
                        {statusLabel(selected)}
                        {selected.size_bytes ? ` | ${formatBytes(selected.size_bytes)}` : ""}
                        {selected.content_truncated ? " | truncado" : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={selected.repo_url}
                        target="_blank"
                        rel="noreferrer"
                        className="border-2 border-primary bg-primary px-3 py-2 text-xs font-bold text-on-primary hover:bg-secondary hover:border-secondary"
                      >
                        Abrir repo
                      </a>
                      {selected.readme_html_url && (
                        <a
                          href={selected.readme_html_url}
                          target="_blank"
                          rel="noreferrer"
                          className="border-2 border-secondary px-3 py-2 text-xs font-bold text-secondary hover:bg-secondary hover:text-on-primary"
                        >
                          README original
                        </a>
                      )}
                    </div>
                  </div>
                  {selected.bookmark_ids && selected.bookmark_ids.length > 0 && (
                    <p className="mt-3 break-words text-[11px] text-on-surface-variant">
                      DB IDs: {selected.bookmark_ids.join(", ")}
                    </p>
                  )}
                </header>

                <ClassificationSummary classification={selected.classification} />

                {selected.status === "ok" ? (
                  <pre className="max-h-[calc(100vh-310px)] overflow-auto whitespace-pre-wrap break-words p-5 text-sm leading-relaxed text-on-surface-variant">
                    {selected.content || ""}
                  </pre>
                ) : (
                  <div className="p-8 text-sm text-on-surface-variant">
                    {selected.error_message || "README aun no disponible."}
                  </div>
                )}
              </article>
            )}
          </main>
        </div>
      </div>
    </section>
  );
}
