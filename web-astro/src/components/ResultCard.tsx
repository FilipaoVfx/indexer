import { useState } from "react";
import type { SearchItem } from "../lib/api";
import {
  extractContextLinks,
  extractGithubRepos,
  formatDate,
  getDisplayAssetType,
  getPrimaryResourceUrl,
  initials,
  isGithubRepoUrl,
  safeDomain,
} from "../lib/api";
import { withBase } from "../lib/url-state";

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
  const primaryUrl = getPrimaryResourceUrl(item);
  const domain =
    item.source_domain || safeDomain(primaryUrl || item.source_url || "");

  const mediaAll = item.media || [];
  const profileUrl = mediaAll.find((m) => /\/profile_images\//i.test(m)) || null;
  const otherMedia = profileUrl ? mediaAll.filter((m) => m !== profileUrl) : mediaAll;

  const tags: string[] = [];
  const displayAssetType = getDisplayAssetType(item);
  if (displayAssetType) tags.push(formatAssetType(displayAssetType));
  if (item.difficulty) tags.push(formatDifficulty(item.difficulty));
  if (domain) tags.push(domain);
  if (otherMedia.length > 0) tags.push(`${otherMedia.length} multimedia`);
  if ((item.links || []).length > 0) tags.push(`${item.links!.length} enlaces`);

  const cardRepos = [...extractGithubRepos([item]).values()].slice(0, 4);
  const readmeSlugs = new Set((item.github_readmes || []).map((readme) => readme.repo_slug));
  const contextLinks = extractContextLinks(item, primaryUrl).slice(0, expanded ? 4 : 2);
  const primaryCtaLabel =
    primaryUrl && isGithubRepoUrl(primaryUrl) ? "Abrir repo" : "Abrir fuente";

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
      <span className="ml-2 text-[10px] font-bold text-on-primary bg-primary border-2 border-primary px-2 py-0.5">
        {item.score.toFixed(3)}
      </span>
    ) : null;

  return (
    <article
      id={anchorId || undefined}
      className="group relative scroll-mt-24 bg-surface-container-lowest p-6 border-2 border-outline-variant hover:border-primary hover:neo-shadow transition-all duration-150"
    >
      <div className="flex justify-between items-start mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 bg-surface-container-highest border-2 border-primary flex items-center justify-center flex-shrink-0 overflow-hidden">
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
            className={`flex items-center gap-1.5 px-2.5 py-1 border-2 border-outline-variant bg-surface-container-high ${kindColor} text-[10px] uppercase tracking-widest font-bold`}
          >
            <span className={`w-1.5 h-1.5 ${kindBg}`} />
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
              className="inline-flex items-center border-2 border-secondary bg-surface-container-low px-2 py-0.5 text-[11px] text-secondary font-bold"
            >
              {formatReason(reason)}
            </span>
          ))}
        </div>
      )}

      {item.readme_match?.preview && (
        <div className="mb-4 border-2 border-outline-variant bg-surface-container-lowest p-3">
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="text-[10px] font-mono uppercase tracking-wider text-primary">
              $ readme --match {item.readme_match.slug}
            </p>
            {typeof item.readme_match.score === "number" &&
              item.readme_match.score > 0 && (
                <span className="text-[10px] font-mono text-on-surface-variant">
                  score {item.readme_match.score.toFixed(3)}
                </span>
              )}
          </div>
          <p className="text-[11px] text-on-surface-variant leading-relaxed line-clamp-3 whitespace-pre-wrap break-words">
            {item.readme_match.preview}
          </p>
        </div>
      )}

      {otherMedia.length > 0 && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setMediaOpen((prev) => !prev)}
            aria-expanded={mediaOpen}
            className="inline-flex items-center gap-1.5 border-2 border-outline-variant bg-surface-container-high px-3 py-1.5 text-xs font-semibold text-on-surface transition-colors hover:text-primary hover:border-primary"
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
                  className="aspect-video border-2 border-outline-variant hover:border-secondary overflow-hidden bg-surface-container-highest block transition-colors"
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
            <span key={`${r.owner}/${r.repo}`} className="inline-flex flex-wrap gap-1">
              <a
                href={`https://github.com/${r.owner}/${r.repo}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 border-2 border-primary bg-surface-container-low text-primary text-[11px] font-bold px-2 py-0.5 hover:bg-primary hover:text-on-primary transition-colors"
              >
                <span className="material-symbols-outlined text-xs">code</span>
                {r.owner}/{r.repo}
              </a>
              {readmeSlugs.has(`${r.owner}/${r.repo}`.toLowerCase()) && (
                <a
                  href={withBase(`/readmes?repo=${encodeURIComponent(`${r.owner}/${r.repo}`)}`)}
                  className="inline-flex items-center gap-1 border-2 border-secondary bg-surface-container-low text-secondary text-[11px] font-bold px-2 py-0.5 hover:bg-secondary hover:text-on-primary transition-colors"
                >
                  README
                </a>
              )}
            </span>
          ))}
        </div>
      )}

      {contextLinks.length > 0 && (
        <div className="mb-4 space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
            Detalles
          </p>
          <div className="space-y-1.5">
            {contextLinks.map((link) => (
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
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex gap-2 flex-wrap">
          {tags.map((t) => (
            <span
              key={t}
              className="border border-outline-variant bg-surface-container-highest text-on-surface-variant px-2.5 py-1 text-xs font-mono"
            >
              {t}
            </span>
          ))}
        </div>
        {primaryUrl ? (
          <a
            href={primaryUrl}
            target="_blank"
            rel="noreferrer"
            className="bg-primary text-on-primary border-2 border-primary px-3 py-1.5 text-sm font-bold uppercase tracking-wider flex items-center gap-1 hover:bg-secondary hover:border-secondary transition-colors"
          >
            {primaryCtaLabel}{" "}
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
