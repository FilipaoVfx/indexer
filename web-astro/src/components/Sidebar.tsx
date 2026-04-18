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
    <aside className="hidden md:flex flex-col h-full py-8 px-4 gap-4 bg-[#060e20] bg-gradient-to-r from-[#0b1326] to-transparent w-64 border-r border-outline-variant/15">
      <div className="mb-8 px-4">
        <h1 className="text-[#c0c1ff] font-headline font-bold text-2xl tracking-tighter">
          Consola
        </h1>
        <p className="text-[#dae2fd] opacity-60 text-xs">Indexbook v1.0</p>
      </div>

      <nav className="flex flex-col gap-2 flex-grow">
        {ITEMS.map((it) => {
          const active = it.key === activeKey;
          return (
            <a
              key={it.key}
              href={withBase(it.href)}
              className={
                "flex items-center gap-3 px-4 py-3 rounded-lg transition-all " +
                (active
                  ? "text-[#c0c1ff] font-bold bg-[#31394d] translate-x-1"
                  : "text-[#dae2fd] opacity-60 hover:bg-[#31394d] hover:opacity-100")
              }
            >
              <span className="material-symbols-outlined text-lg">{it.icon}</span>
              <span className="text-sm font-medium">{it.label}</span>
            </a>
          );
        })}
      </nav>

      <div className="mx-4 mt-4 py-3 px-4 bg-surface-container-low rounded-lg border border-outline-variant/20">
        <div className="text-[10px] uppercase tracking-widest text-on-surface-variant mb-1">
          Estado de la base
        </div>
        <div className="flex items-center gap-2">
          <span
            className={
              "w-2 h-2 rounded-full animate-pulse " +
              (isLive ? "bg-secondary" : "bg-error")
            }
          />
          <span
            className={
              "text-xs font-bold " + (isLive ? "text-secondary" : "text-error")
            }
          >
            {status}
          </span>
        </div>
        <div className="mt-2 text-xs text-on-surface">
          <span>{count}</span>{" "}
          <span className="text-on-surface-variant">registros</span>
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-1">
        <a
          href="https://github.com/FilipaoVfx/indexer"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-3 px-4 py-2 text-[#dae2fd] opacity-60 hover:bg-[#31394d] hover:opacity-100 transition-all rounded-lg"
        >
          <span className="material-symbols-outlined text-lg">code</span>
          <span className="text-sm font-medium">Codigo fuente</span>
        </a>
      </div>
    </aside>
  );
}
