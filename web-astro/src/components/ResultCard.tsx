import { useState } from "react";
import type { SearchItem } from "../lib/api";
import { extractGithubRepos, formatDate, initials, safeDomain } from "../lib/api";

interface Props {
  item: SearchItem;
  anchorId?: string;
}

const LONG_TEXT_CHARS = 320;

function safeHighlight(raw: string): string {
  return String(raw || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}

function formatAssetType(value?: string): string {
  switch (value) {
    case "tool":
      return "herramienta";
    case "thread":
      return "hilo";
    case "repo":
      return "repo";
    case "tutorial":
      return "tutorial";
    case "article":
      return "articulo";
    default:
      return value || "";
  }
}

function formatDifficulty(value?: string): string {
  switch (value) {
    case "beginner":
      return "basico";
    case "intermediate":
      return "intermedio";
    case "advanced":
      return "avanzado";
    default:
      return value || "";
  }
}

function formatReason(reason: string): string {
  const [prefix, rawValue] = String(reason).split(":");
  const value = rawValue || "";

  switch (prefix) {
    case "components":
      return `componentes:${value}`;
    case "intent":
      return `intencion:${value === "build" ? "construir" : value}`;
    case "asset_type":
      return `tipo:${formatAssetType(value)}`;
    case "topics":
      return `temas:${value}`;
    case "graph":
      return `grafo:${value}`;
    default:
      return reason;
  }
}

export default function ResultCard({ item, anchorId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const author = item.author_name || item.author_username || "anonimo";
  const handle = item.author_username ? `@${item.author_username}` : "";
  const userId = item.user_id || "";
  const date = formatDate(item.created_at);
  const hasHighlight = Boolean(
    item.highlight && String(item.highlight).includes("<mark>")
  );
  const bodyText = hasHighlight
    ? String(item.highlight)
    : item.text_content || item.summary || "--- Sin contenido ---";
  const isLong = bodyText.length > LONG_TEXT_CHARS;
  const showToggle = isLong;
  const domain =
    item.source_domain || (item.source_url ? safeDomain(item.source_url) : "");

  const mediaAll = item.media || [];
  const profileUrl = mediaAll.find((m) => /\/profile_images\//i.test(m)) || null;
  const otherMedia = profileUrl ? mediaAll.filter((m) => m !== profileUrl) : mediaAll;

  const tags: string[] = [];
  if (item.asset_type) tags.push(formatAssetType(item.asset_type));
  if (item.difficulty) tags.push(formatDifficulty(item.difficulty));
  if (domain) tags.push(domain);
  if (otherMedia.length > 0) tags.push(`${otherMedia.length} multimedia`);
  if ((item.links || []).length > 0) tags.push(`${item.links!.length} enlaces`);

  const cardRepos = [...extractGithubRepos([item]).values()].slice(0, 4);

  const kind =
    otherMedia.length > 0
      ? "Multimedia"
      : (item.links || []).length > 0
      ? "Referencia"
      : "Sintesis";
  const kindColor =
    kind === "Media"
      ? "text-tertiary"
      : kind === "Reference"
      ? "text-secondary"
      : "text-primary";
  const kindBg =
    kind === "Media"
      ? "bg-tertiary"
      : kind === "Reference"
      ? "bg-secondary"
      : "bg-primary";

  const scoreBadge =
    typeof item.score === "number" && !isNaN(item.score) && item.score > 0 ? (
      <span className="ml-2 text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded">
        {item.score.toFixed(3)}
      </span>
    ) : null;

  return (
    <article
      id={anchorId || undefined}
      className="group relative scroll-mt-24 bg-surface-container-lowest p-6 rounded-xl hover:bg-surface-container-low transition-all duration-300 border-l-4 border-transparent hover:border-primary"
    >
      <div className="flex justify-between items-start mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full bg-surface-container-highest flex items-center justify-center flex-shrink-0 overflow-hidden">
            {profileUrl && !avatarFailed ? (
              <img
                src={profileUrl}
                alt={author}
                loading="lazy"
                className="w-full h-full object-cover"
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <span className="text-sm font-bold text-primary">
                {initials(author)}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-on-surface font-semibold text-sm truncate">
              {author}
            </p>
            <p className="text-on-surface-variant text-xs truncate">
              {handle} {handle ? "•" : ""} {date}
            </p>
            {userId && (
              <p className="text-[10px] uppercase tracking-widest text-on-surface-variant truncate">
                usuario {userId}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`flex items-center gap-1.5 px-2.5 py-1 bg-surface-container-high ${kindColor} text-[10px] uppercase tracking-widest font-bold rounded`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${kindBg}`} />
            {kind}
          </span>
          {scoreBadge}
        </div>
      </div>

      <div className="mb-4">
        {hasHighlight ? (
          <div
            className={`text-on-surface-variant text-sm leading-relaxed whitespace-pre-wrap break-words ${
              showToggle && !expanded ? "line-clamp-6" : ""
            }`}
            dangerouslySetInnerHTML={{ __html: safeHighlight(bodyText) }}
          />
        ) : (
          <p
            className={`text-on-surface-variant text-sm leading-relaxed whitespace-pre-wrap break-words ${
              showToggle && !expanded ? "line-clamp-6" : ""
            }`}
          >
            {bodyText}
          </p>
        )}
        {showToggle && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="mt-2 inline-flex items-center gap-1 text-primary text-xs font-semibold hover:underline"
            aria-expanded={expanded}
          >
            {expanded ? "Mostrar menos" : "Mostrar mas"}
            <span className="material-symbols-outlined text-sm">
              {expanded ? "expand_less" : "expand_more"}
            </span>
          </button>
        )}
      </div>

      {item.why_this_result && item.why_this_result.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {item.why_this_result.slice(0, 4).map((reason) => (
            <span
              key={reason}
              className="inline-flex items-center rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-[11px] text-primary"
            >
              {formatReason(reason)}
            </span>
          ))}
        </div>
      )}

      {otherMedia.length > 0 && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setMediaOpen((prev) => !prev)}
            aria-expanded={mediaOpen}
            className="inline-flex items-center gap-1.5 rounded-lg bg-surface-container-high px-3 py-1.5 text-xs font-semibold text-on-surface transition-colors hover:text-primary"
          >
            <span className="material-symbols-outlined text-sm">image</span>
            {mediaOpen ? "Ocultar" : "Ver"} {otherMedia.length} multimedia
            <span
              className={`material-symbols-outlined text-sm transition-transform ${
                mediaOpen ? "rotate-180" : ""
              }`}
            >
              expand_more
            </span>
          </button>
          {mediaOpen && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              {otherMedia.map((m, i) => (
                <a
                  key={i}
                  href={m}
                  target="_blank"
                  rel="noreferrer"
                  className="aspect-video rounded-lg overflow-hidden bg-surface-container-highest block"
                >
                  <img
                    src={m}
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {cardRepos.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {cardRepos.map((r) => (
            <a
              key={`${r.owner}/${r.repo}`}
              href={`https://github.com/${r.owner}/${r.repo}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 bg-primary/10 border border-primary/30 text-primary text-[11px] font-medium px-2 py-0.5 rounded hover:bg-primary/20 transition-colors"
            >
              <span className="material-symbols-outlined text-xs">code</span>
              {r.owner}/{r.repo}
            </a>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex gap-2 flex-wrap">
          {tags.map((t) => (
            <span
              key={t}
              className="bg-surface-container-highest text-on-surface-variant px-2.5 py-1 rounded text-xs"
            >
              {t}
            </span>
          ))}
        </div>
        {item.source_url ? (
          <a
            href={item.source_url}
            target="_blank"
            rel="noreferrer"
            className="text-primary text-sm font-medium flex items-center gap-1 hover:underline"
          >
            Abrir fuente{" "}
            <span className="material-symbols-outlined text-sm">arrow_outward</span>
          </a>
        ) : (
          <span className="text-xs text-on-surface-variant">
            ID: {item.tweet_id || item.id || ""}
          </span>
        )}
      </div>
    </article>
  );
}
