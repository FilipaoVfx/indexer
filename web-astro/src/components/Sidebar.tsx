/**
 * Sidebar with functional navigation.
 * Each button either navigates to a dedicated view or toggles a query filter.
 */
import { useEffect, useState } from "react";
import { fetchHealth } from "../lib/api";
import { withBase } from "../lib/url-state";

type NavKey = "all" | "recent" | "media" | "links" | "authors" | "repos" | "readmes";

interface Props {
  current?: NavKey;
}

const COLLAPSE_STORAGE_KEY = "indexbook.sidebar.collapsed";

const ITEMS: { key: NavKey; label: string; icon: string; href: string }[] = [
  { key: "all", label: "Todo el archivo", icon: "grid_view", href: "/" },
  { key: "recent", label: "Recientes", icon: "auto_graph", href: "/?sort=recent" },
  { key: "media", label: "Con multimedia", icon: "auto_stories", href: "/?kind=media" },
  { key: "links", label: "Con enlaces", icon: "link", href: "/?kind=links" },
  { key: "authors", label: "Autores", icon: "group", href: "/authors" },
  { key: "repos", label: "Repos de GitHub", icon: "hub", href: "/repos" },
  { key: "readmes", label: "README repos", icon: "description", href: "/readmes" },
];

export default function Sidebar({ current = "all" }: Props) {
  const [status, setStatus] = useState<"EN LINEA" | "SIN CONEXION" | "---">("---");
  const [count, setCount] = useState<string>("---");
  const [activeKey, setActiveKey] = useState<NavKey>(current);
  const [collapsed, setCollapsed] = useState(false);

  function buildNavHref(href: string) {
    if (typeof window === "undefined") return withBase(href);
    const currentParams = new URLSearchParams(window.location.search);
    const user = currentParams.get("user") || "";
    if (!user) return withBase(href);

    const [pathname, rawQuery = ""] = href.split("?");
    const params = new URLSearchParams(rawQuery);
    params.set("user", user);
    return withBase(`${pathname}${params.toString() ? `?${params.toString()}` : ""}`);
  }

  useEffect(() => {
    let mounted = true;
    async function refresh() {
      try {
        const h = await fetchHealth();
        if (!mounted) return;
        if (!h.ok) throw new Error();
        setStatus("EN LINEA");
        setCount(
          typeof h.total_bookmarks === "number"
            ? h.total_bookmarks.toLocaleString()
            : "---"
        );
      } catch {
        if (!mounted) return;
        setStatus("SIN CONEXION");
      }
    }
    refresh();
    const id = setInterval(refresh, 15000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    setCollapsed(stored === "1");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    if (current !== "all") {
      setActiveKey(current);
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const kind = params.get("kind");
    const sort = params.get("sort");

    if (kind === "media") {
      setActiveKey("media");
      return;
    }

    if (kind === "links") {
      setActiveKey("links");
      return;
    }

    if (sort === "recent") {
      setActiveKey("recent");
      return;
    }

    setActiveKey("all");
  }, [current]);

  const isLive = status === "EN LINEA";

  return (
    <aside
      className={`hidden md:flex h-full shrink-0 flex-col gap-4 border-r-2 border-primary bg-background py-6 transition-[width,padding] duration-200 ${
        collapsed ? "w-20 px-2" : "w-64 px-4"
      }`}
    >
      <div className={`mb-6 terminal-panel ${collapsed ? "px-2 py-3" : "px-3 py-3"}`}>
        <div className={`flex items-start ${collapsed ? "justify-center" : "justify-between gap-3"}`}>
          <div className={collapsed ? "text-center" : "min-w-0"}>
            <h1 className="text-primary font-headline font-bold tracking-tight">
              {collapsed ? (
                <span className="text-lg">ib</span>
              ) : (
                <>
                  <span className="text-secondary">$</span> indexbook
                </>
              )}
            </h1>
            {!collapsed && (
              <p className="mt-1 text-[10px] text-on-surface-variant caret-blink">
                ~/archive
              </p>
            )}
          </div>
          {!collapsed && (
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className="border-2 border-outline-variant bg-surface-container-high px-2 py-1 text-on-surface-variant transition-colors hover:border-primary hover:text-primary"
              aria-label="Colapsar menu lateral"
              title="Colapsar menu lateral"
            >
              <span className="material-symbols-outlined text-base">
                keyboard_double_arrow_left
              </span>
            </button>
          )}
        </div>

        {collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="mt-3 flex w-full items-center justify-center border-2 border-outline-variant bg-surface-container-high px-2 py-1 text-on-surface-variant transition-colors hover:border-primary hover:text-primary"
            aria-label="Expandir menu lateral"
            title="Expandir menu lateral"
          >
            <span className="material-symbols-outlined text-base">
              keyboard_double_arrow_right
            </span>
          </button>
        )}
      </div>

      <nav className="flex flex-col gap-2 flex-grow">
        {ITEMS.map((it) => {
          const active = it.key === activeKey;
          return (
            <a
              key={it.key}
              href={buildNavHref(it.href)}
              aria-label={it.label}
              title={collapsed ? it.label : undefined}
              className={
                `flex items-center border-2 py-2 text-sm font-medium transition-all ${
                  collapsed ? "justify-center px-2" : "gap-3 px-3"
                } ` +
                (active
                  ? "border-primary bg-primary text-on-primary neo-shadow-purple-sm"
                  : "border-transparent text-on-surface-variant hover:border-secondary hover:text-secondary hover:bg-surface-container")
              }
            >
              <span className="material-symbols-outlined text-lg">{it.icon}</span>
              {!collapsed && <span className="uppercase tracking-wide">{it.label}</span>}
            </a>
          );
        })}
      </nav>

      <div
        className={`mx-1 mt-4 border-2 border-outline-variant bg-surface-container-low ${
          collapsed ? "px-2 py-3" : "px-3 py-3"
        }`}
      >
        {!collapsed && (
          <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-secondary">
            <span className="text-primary">&gt;</span> status
          </div>
        )}
        <div className={`flex items-center ${collapsed ? "justify-center" : "gap-2"}`}>
          <span
            className={
              "w-2 h-2 animate-pulse " +
              (isLive ? "bg-primary" : "bg-error")
            }
          />
          <span
            className={
              "text-xs font-bold uppercase " + (isLive ? "text-primary" : "text-error")
            }
          >
            {status}
          </span>
        </div>
        {collapsed ? (
          <div className="mt-2 text-center text-[11px] font-bold text-secondary">
            {count}
          </div>
        ) : (
          <div className="mt-2 text-xs">
            <span className="text-secondary font-bold">{count}</span>{" "}
            <span className="text-on-surface-variant">records</span>
          </div>
        )}
      </div>

      <div className="mt-auto flex flex-col gap-1">
        <a
          href="https://github.com/FilipaoVfx/indexer"
          target="_blank"
          rel="noreferrer"
          aria-label="Source"
          title={collapsed ? "Source" : undefined}
          className={`flex items-center border-2 border-transparent py-2 text-sm font-medium text-on-surface-variant transition-all hover:border-secondary hover:text-secondary ${
            collapsed ? "justify-center px-2" : "gap-3 px-3"
          }`}
        >
          <span className="material-symbols-outlined text-lg">code</span>
          {!collapsed && <span className="uppercase tracking-wide">Source</span>}
        </a>
      </div>
    </aside>
  );
}
