/**
 * Sidebar with functional navigation.
 * Each button either navigates to a dedicated view or toggles a query filter.
 */
import { useEffect, useState } from "react";
import { fetchHealth } from "../lib/api";
import { withBase } from "../lib/url-state";

type NavKey = "all" | "recent" | "media" | "links" | "authors" | "repos";

interface Props {
  current?: NavKey;
}

const ITEMS: { key: NavKey; label: string; icon: string; href: string }[] = [
  { key: "all", label: "Todo el archivo", icon: "grid_view", href: "/" },
  { key: "recent", label: "Recientes", icon: "auto_graph", href: "/?sort=recent" },
  { key: "media", label: "Con multimedia", icon: "auto_stories", href: "/?kind=media" },
  { key: "links", label: "Con enlaces", icon: "link", href: "/?kind=links" },
  { key: "authors", label: "Autores", icon: "group", href: "/authors" },
  { key: "repos", label: "Repos de GitHub", icon: "hub", href: "/repos" },
];

export default function Sidebar({ current = "all" }: Props) {
  const [status, setStatus] = useState<"EN LINEA" | "SIN CONEXION" | "---">("---");
  const [count, setCount] = useState<string>("---");
  const [activeKey, setActiveKey] = useState<NavKey>(current);

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
    <aside className="hidden md:flex flex-col h-full py-6 px-4 gap-4 bg-background w-64 border-r-2 border-primary">
      <div className="mb-6 px-3 py-3 terminal-panel">
        <h1 className="text-primary font-headline font-bold text-lg tracking-tight">
          <span className="text-secondary">$</span> indexbook
        </h1>
        <p className="text-on-surface-variant text-[10px] mt-1 caret-blink">
          ~/archive
        </p>
      </div>

      <nav className="flex flex-col gap-2 flex-grow">
        {ITEMS.map((it) => {
          const active = it.key === activeKey;
          return (
            <a
              key={it.key}
              href={buildNavHref(it.href)}
              className={
                "flex items-center gap-3 px-3 py-2 border-2 transition-all text-sm font-medium " +
                (active
                  ? "border-primary bg-primary text-on-primary neo-shadow-purple-sm"
                  : "border-transparent text-on-surface-variant hover:border-secondary hover:text-secondary hover:bg-surface-container")
              }
            >
              <span className="material-symbols-outlined text-lg">{it.icon}</span>
              <span className="uppercase tracking-wide">{it.label}</span>
            </a>
          );
        })}
      </nav>

      <div className="mx-1 mt-4 py-3 px-3 border-2 border-outline-variant bg-surface-container-low">
        <div className="text-[10px] uppercase tracking-widest text-secondary mb-2 font-bold">
          <span className="text-primary">&gt;</span> status
        </div>
        <div className="flex items-center gap-2">
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
        <div className="mt-2 text-xs">
          <span className="text-secondary font-bold">{count}</span>{" "}
          <span className="text-on-surface-variant">records</span>
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-1">
        <a
          href="https://github.com/FilipaoVfx/indexer"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-3 px-3 py-2 border-2 border-transparent text-on-surface-variant hover:border-secondary hover:text-secondary transition-all text-sm font-medium"
        >
          <span className="material-symbols-outlined text-lg">code</span>
          <span className="uppercase tracking-wide">Source</span>
        </a>
      </div>
    </aside>
  );
}
