import { ragSearch, getTopTrustScores, getRepoTrustScores } from "./rag-orchestrator.js";
import { getPineconeStats } from "./rag-pinecone.js";
import { createClient } from "@supabase/supabase-js";
import { Telegraf, Markup } from "telegraf";

let bot = null;
let botUsername = "";
const startedAt = Date.now();

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  return createClient(url, key);
}

function escapeMD(text) {
  return text?.replace(/_/g, "\\_").replace(/\*/g, "\\*").replace(/`/g, "\\`").replace(/\[/g, "\\[").replace(/\]/g, "\\]") || "";
}

function menuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔍 Buscar", "menu_search"),
     Markup.button.callback("📊 Data", "menu_data")],
    [Markup.button.callback("📈 Status", "menu_status"),
     Markup.button.callback("❓ Help", "menu_help")],
  ]);
}

function navRow() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🏠 Menú", "menu_main")],
  ]);
}

function getBot() {
  if (bot) return bot;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  return Promise.resolve().then(async () => {
    bot = new Telegraf(token);

    const me = await bot.telegram.getMe();
    botUsername = me.username;

    // ─── /start ────────────────────────────────────────────────
    bot.start((ctx) => {
      ctx.reply(
        "📚 *Indexer RAG Bot*\n\n" +
        "Busca en tu base de conocimiento técnico: bookmarks " +
        "y READMEs de GitHub indexados con RAG.\n\n" +
        "*Comandos:*\n" +
        "🔍 /search `<query>` — Buscar en todo\n" +
        "📊 /data — Ver fuentes disponibles\n" +
        "📈 /status — Estado del sistema\n" +
        "⭐ /trust `<repo>` — Trust score de un repo\n" +
        "🏆 /top — Top repos por trust score\n" +
        "🏠 /menu — Menú de navegación\n" +
        "❓ /help — Ayuda detallada\n\n" +
        "_También podés escribir cualquier consulta " +
        "directamente en chat privado._",
        { parse_mode: "Markdown", ...menuKeyboard() }
      );
    });

    // ─── /help ─────────────────────────────────────────────────
    bot.help((ctx) => {
      ctx.reply(
        "📚 *Indexer RAG Bot — Ayuda*\n\n" +
        "*Comandos:*\n" +
        "🔍 `/search <query>` — Buscar en bookmarks y READMEs\n" +
        "📂 `/filter bookmark <query>` — Solo bookmarks\n" +
        "📂 `/filter readme <query>` — Solo READMEs\n" +
        "📊 `/data` — Ver fuentes de datos disponibles\n" +
        "📈 `/status` — Estado detallado del sistema\n" +
        "🏠 `/menu` — Mostrar menú de navegación\n\n" +
        "*En grupos:*\n" +
        "Mencioná al bot: `@ReposBot <query>`\n" +
        "O respondé a un mensaje del bot\n\n" +
        "*Ejemplos:*\n" +
        "→ `react hooks patterns`\n" +
        "→ `/search ai agents tools`\n" +
        "→ `/filter readme supabase auth`",
        { parse_mode: "Markdown", ...menuKeyboard() }
      );
    });

    // ─── /menu ─────────────────────────────────────────────────
    bot.command("menu", (ctx) => {
      ctx.reply("🏠 *Menú de navegación*\n\nElegí una opción:", {
        parse_mode: "Markdown",
        ...menuKeyboard(),
      });
    });

    // ─── /data ──────────────────────────────────────────────────
    bot.command("data", async (ctx) => {
      await ctx.replyWithChatAction("typing");
      try {
        const db = getSupabase();

        const [{ count: bmCount }, { count: rmCount }, { count: bmSync }, { count: rmSync }] =
          await Promise.all([
            db.from("bookmarks").select("id", { count: "exact", head: true }),
            db.from("github_repo_readmes").select("id", { count: "exact", head: true }).eq("status", "ok"),
            db.from("rag_sync_state").select("id", { count: "exact", head: true }).eq("source_type", "bookmark"),
            db.from("rag_sync_state").select("id", { count: "exact", head: true }).eq("source_type", "readme"),
          ]);

        let uniqueRepos = new Set();
        let offset = 0;
        const PAGE = 1000;
        while (true) {
          const { data: page } = await db
            .from("rag_sync_state")
            .select("source_id")
            .eq("source_type", "readme")
            .range(offset, offset + PAGE - 1);
          if (!page || page.length === 0) break;
          for (const r of page) uniqueRepos.add(r.source_id);
          if (page.length < PAGE) break;
          offset += PAGE;
        }

        let msg =
          "📊 *Fuentes de datos*\n\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
          "🔖 *Bookmarks*\n" +
          `   Total: ${bmCount || 0}\n` +
          `   Indexados: ${bmSync || 0} chunks\n\n` +
          "📦 *GitHub READMEs*\n" +
          `   Repos: ${uniqueRepos.size}\n` +
          `   Indexados: ${rmSync || 0} chunks\n\n` +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
          "_La búsqueda combina ambas fuentes " +
          "con ranking por similitud semántica._";

        ctx.reply(msg, { parse_mode: "Markdown", ...menuKeyboard() });
      } catch (err) {
        ctx.reply(`❌ Error al obtener data: ${err.message}`, menuKeyboard());
      }
    });

    // ─── /status ───────────────────────────────────────────────
    bot.command("status", async (ctx) => {
      await ctx.replyWithChatAction("typing");
      try {
        const db = getSupabase();

        const [pineconeStats, { count: bmSync }, { count: rmSync }] =
          await Promise.all([
            getPineconeStats(),
            db.from("rag_sync_state").select("id", { count: "exact", head: true }).eq("source_type", "bookmark"),
            db.from("rag_sync_state").select("id", { count: "exact", head: true }).eq("source_type", "readme"),
          ]);

        const uptime = Math.floor((Date.now() - startedAt) / 1000);
        const days = Math.floor(uptime / 86400);
        const hours = Math.floor((uptime % 86400) / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        const uptimeStr = `${days}d ${hours}h ${mins}m`;

        const totalVectors = pineconeStats?.totalRecordCount || 0;

        let msg =
          "📈 *Estado del Sistema*\n\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
          "⏱ *Bot:*\n" +
          `   Uptime: ${uptimeStr}\n` +
          `   Versión: 1.0.0\n\n` +
          "🌲 *Pinecone:*\n" +
          `   Vectores: ${totalVectors}\n` +
          `   Dimensión: ${pineconeStats?.dimension || 1536}\n` +
          `   Namespaces: ${Object.keys(pineconeStats?.namespaces || {}).length}\n\n` +
          "🔄 *Sincronización:*\n" +
          `   Bookmarks: ${bmSync || 0} chunks\n` +
          `   READMEs: ${rmSync || 0} chunks`;

        ctx.reply(msg, { parse_mode: "Markdown", ...menuKeyboard() });
      } catch (err) {
        ctx.reply(`❌ Error al obtener estado: ${err.message}`, menuKeyboard());
      }
    });

    // ─── /search ───────────────────────────────────────────────
    bot.command("search", async (ctx) => {
      const query = ctx.message.text.replace("/search", "").trim();
      if (!query) {
        return ctx.reply("Uso: /search `<query>`", {
          parse_mode: "Markdown",
          ...menuKeyboard(),
        });
      }

      await ctx.replyWithChatAction("typing");

      try {
        const results = await ragSearch(query, { topK: 3, interface: "telegram" });
        ctx.reply(formatTelegramResults(results), {
          parse_mode: "Markdown",
          ...navRow(),
        });
      } catch (err) {
        ctx.reply(`❌ Error: ${err.message}`, menuKeyboard());
      }
    });

    // ─── /filter ───────────────────────────────────────────────
    bot.command("filter", async (ctx) => {
      const parts = ctx.message.text.replace("/filter", "").trim().split(" ");
      const sourceType = parts[0];
      const query = parts.slice(1).join(" ");

      if (!["bookmark", "readme"].includes(sourceType) || !query) {
        return ctx.reply("Uso: /filter `<bookmark|readme>` `<query>`", {
          parse_mode: "Markdown",
          ...menuKeyboard(),
        });
      }

      await ctx.replyWithChatAction("typing");

      try {
        const results = await ragSearch(query, { topK: 5, sourceType, interface: "telegram" });
        ctx.reply(formatTelegramResults(results), {
          parse_mode: "Markdown",
          ...navRow(),
        });
      } catch (err) {
        ctx.reply(`❌ Error: ${err.message}`, menuKeyboard());
      }
    });

    // ─── /trust ────────────────────────────────────────────────
    bot.command("trust", async (ctx) => {
      const input = ctx.message.text.replace("/trust", "").trim().toLowerCase();
      if (!input) {
        return ctx.reply("Uso: /trust `<owner/repo>`\nEj: `/trust facebook/react`", {
          parse_mode: "Markdown",
          ...menuKeyboard(),
        });
      }

      let slug = input;
      if (slug.includes("github.com/")) {
        slug = slug.match(/github\.com\/([^/]+\/[^/?#]+)/i)?.[1] || slug;
      }

      await ctx.replyWithChatAction("typing");

      try {
        const scores = await getRepoTrustScores([slug]);
        const ts = scores[slug];

        if (!ts || ts.trust_score == null || ts.trust_score <= 0) {
          return ctx.reply(
            `❌ No hay datos de trust score para \`${escapeMD(slug)}\`\n\n` +
            "_Solo repos que aparecen en el CSV de Twitter Analytics tienen trust score._",
            { parse_mode: "Markdown", ...menuKeyboard() }
          );
        }

        const bar = trustBar(ts.trust_score);
        const msg =
          `⭐ *Trust Score: ${escapeMD(slug)}*\n\n` +
          `${bar} **${ts.trust_score}/10**\n\n` +
          "📊 *Desglose:*\n" +
          `   ❤️  Likes promedio:     ${ts.avg_likes}\n` +
          `   💾  Saves promedio:      ${ts.avg_saves}\n` +
          `   📢  Menciones:           ${ts.mentions_count}\n` +
          `   📈  Engagement rate:    ${ts.avg_engagement_rate}%\n\n` +
          `🔗 [Ver tweet fuente](${ts.source_url})`;

        ctx.reply(msg, { parse_mode: "Markdown", ...menuKeyboard() });
      } catch (err) {
        ctx.reply(`❌ Error: ${err.message}`, menuKeyboard());
      }
    });

    // ─── /top ──────────────────────────────────────────────────
    bot.command("top", async (ctx) => {
      await ctx.replyWithChatAction("typing");
      try {
        const tops = await getTopTrustScores(10);
        if (!tops || tops.length === 0) {
          return ctx.reply("No hay datos de trust score disponibles.", menuKeyboard());
        }

        let msg = "🏆 *Top 10 — Trust Score*\n\n";
        tops.forEach((r, i) => {
          const bar = trustBar(r.trust_score);
          msg += `${i + 1}. \`${escapeMD(r.repo_slug)}\`\n`;
          msg += `   ${bar} ${r.trust_score}/10  ❤️ ${r.avg_likes}  💾 ${r.avg_saves}\n\n`;
        });

        ctx.reply(msg, { parse_mode: "Markdown", ...menuKeyboard() });
      } catch (err) {
        ctx.reply(`❌ Error: ${err.message}`, menuKeyboard());
      }
    });

    // ─── Inline Keyboard Callbacks ─────────────────────────────
    bot.action("menu_main", async (ctx) => {
      await ctx.editMessageText("🏠 *Menú de navegación*\n\nElegí una opción:", {
        parse_mode: "Markdown",
        ...menuKeyboard(),
      });
    });

    bot.action("menu_search", async (ctx) => {
      await ctx.editMessageText(
        "🔍 *Buscar*\n\n" +
        "Usá `/search <query>` para buscar en todas las fuentes.\n" +
        "O `/filter bookmark <query>` o `/filter readme <query>` " +
        "para filtrar por tipo.\n\n" +
        "También podés escribir directamente tu consulta.",
        { parse_mode: "Markdown", ...menuKeyboard() }
      );
    });

    bot.action("menu_data", async (ctx) => {
      await ctx.answerCbQuery();
      // Reuse /data logic inline
      try {
        const db = getSupabase();
        const [{ count: bmCount }, { count: rmCount }, { count: bmSync }, { count: rmSync }] =
          await Promise.all([
            db.from("bookmarks").select("id", { count: "exact", head: true }),
            db.from("github_repo_readmes").select("id", { count: "exact", head: true }).eq("status", "ok"),
            db.from("rag_sync_state").select("id", { count: "exact", head: true }).eq("source_type", "bookmark"),
            db.from("rag_sync_state").select("id", { count: "exact", head: true }).eq("source_type", "readme"),
          ]);

        let uniqueRepos = new Set();
        let offset = 0;
        const PAGE = 1000;
        while (true) {
          const { data: page } = await db
            .from("rag_sync_state")
            .select("source_id")
            .eq("source_type", "readme")
            .range(offset, offset + PAGE - 1);
          if (!page || page.length === 0) break;
          for (const r of page) uniqueRepos.add(r.source_id);
          if (page.length < PAGE) break;
          offset += PAGE;
        }

        let msg =
          "📊 *Fuentes de datos*\n\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
          "🔖 *Bookmarks*\n" +
          `   Total: ${bmCount || 0}\n` +
          `   Indexados: ${bmSync || 0} chunks\n\n` +
          "📦 *GitHub READMEs*\n" +
          `   Repos: ${uniqueRepos.size}\n` +
          `   Indexados: ${rmSync || 0} chunks`;

        await ctx.editMessageText(msg, {
          parse_mode: "Markdown",
          ...menuKeyboard(),
        });
      } catch (err) {
        await ctx.editMessageText(`❌ Error: ${err.message}`, menuKeyboard());
      }
    });

    bot.action("menu_status", async (ctx) => {
      await ctx.answerCbQuery();
      try {
        const db = getSupabase();
        const [pineconeStats, { count: bmSync }, { count: rmSync }] =
          await Promise.all([
            getPineconeStats(),
            db.from("rag_sync_state").select("id", { count: "exact", head: true }).eq("source_type", "bookmark"),
            db.from("rag_sync_state").select("id", { count: "exact", head: true }).eq("source_type", "readme"),
          ]);

        const uptime = Math.floor((Date.now() - startedAt) / 1000);
        const days = Math.floor(uptime / 86400);
        const hours = Math.floor((uptime % 86400) / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        const uptimeStr = `${days}d ${hours}h ${mins}m`;

        let msg =
          "📈 *Estado del Sistema*\n\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
          `⏱ *Bot:* Uptime ${uptimeStr}\n\n` +
          "🌲 *Pinecone:*\n" +
          `   Vectores: ${pineconeStats?.totalRecordCount || 0}\n` +
          `   Dimensión: ${pineconeStats?.dimension || 1536}\n\n` +
          "🔄 *Sync:*\n" +
          `   Bookmarks: ${bmSync || 0}\n` +
          `   READMEs: ${rmSync || 0}`;

        await ctx.editMessageText(msg, {
          parse_mode: "Markdown",
          ...menuKeyboard(),
        });
      } catch (err) {
        await ctx.editMessageText(`❌ Error: ${err.message}`, menuKeyboard());
      }
    });

    bot.action("menu_help", async (ctx) => {
      await ctx.editMessageText(
        "❓ *Ayuda*\n\n" +
        "*Comandos:*\n" +
        "• `/search <q>` — Buscar en todo\n" +
        "• `/filter bookmark <q>` — Solo bookmarks\n" +
        "• `/filter readme <q>` — Solo READMEs\n" +
        "• `/data` — Fuentes disponibles\n" +
        "• `/status` — Estado del sistema\n" +
        "• `/trust <repo>` — Trust score de un repo\n" +
        "• `/top` — Top repos por trust score\n" +
        "• `/menu` — Menú principal\n\n" +
        "*En grupos:*\n" +
        "Mencioná `@ReposBot` o respondé al bot.\n\n" +
        "*Tips:*\n" +
        "Consultas cortas y concretas funcionan mejor.",
        { parse_mode: "Markdown", ...menuKeyboard() }
      );
    });

    // ─── Plain text handler ────────────────────────────────────
    bot.on("text", async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) return;

      const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
      if (isGroup) {
        const botMentioned = text.includes(`@${botUsername}`) ||
                             ctx.message.reply_to_message?.from?.id === bot.botInfo?.id;
        if (!botMentioned) return;
      }

      const cleanText = text.replace(/@\w+/g, "").trim();
      if (!cleanText) return;

      await ctx.replyWithChatAction("typing");

      try {
        const results = await ragSearch(cleanText, { topK: 5, interface: "telegram" });
        ctx.reply(formatTelegramResults(results), {
          parse_mode: "Markdown",
          ...navRow(),
        });
      } catch (err) {
        ctx.reply(`❌ Error: ${err.message}`, menuKeyboard());
      }
    });

    return bot;
  });
}

function trustBar(score) {
  if (score == null || score <= 0) return "";
  const full = Math.round(score / 2);
  const empty = 5 - full;
  return "🟩".repeat(Math.max(0, full)) + "⬜".repeat(Math.max(0, empty));
}

function formatTelegramResults(results) {
  let response = `🔍 _${escapeMD(results.query)}_\n`;
  response += `📊 ${results.total} resultados | ${results.latency_ms}ms\n`;
  response += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";

  if (results.results.length === 0) {
    response += "No se encontraron resultados.";
    return response;
  }

  results.results.forEach((r, i) => {
    const icon = r.source_type === "readme" ? "📦" : "🔖";
    const score = (r.score * 100).toFixed(0);

    let repoName = "";
    if (r.url && r.url.includes("github.com")) {
      const match = r.url.match(/github\.com\/([^/]+\/[^/]+)/);
      if (match) repoName = match[1];
    }

    const title = repoName || escapeMD(r.title);
    response += `${icon} *${i + 1}. ${title}*\n`;
    response += `   📊 ${score}% relevancia`;

    if (r.trust_score != null && r.trust_score > 0) {
      response += ` | ⭐ ${r.trust_score}/10 ❤️ ${r.avg_likes}`;
    }
    response += "\n";

    if (r.url) response += `   🔗 [Abrir enlace](${r.url})\n`;
    if (r.author && r.author !== repoName) response += `   👤 ${escapeMD(r.author)}\n`;
    if (r.tags && r.tags.length > 0) response += `   🏷️ ${r.tags.map(t => escapeMD(t)).join(", ")}\n`;

    let text = r.text
      .replace(/Author:.*?\n/g, "")
      .replace(/URL:.*?\n/g, "")
      .replace(/\n+/g, " ")
      .replace(/_/g, "\\_")
      .replace(/\*/g, "\\*")
      .replace(/`/g, "\\`")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]")
      .trim();

    if (text.length > 150) text = text.slice(0, 147) + "...";
    response += `   📝 ${text}\n\n`;
  });

  return response;
}

export async function startTelegramBot() {
  const telegramBot = await getBot();

  telegramBot.launch();
  console.log("[Telegram] Bot started");

  process.once("SIGINT", () => telegramBot.stop("SIGINT"));
  process.once("SIGTERM", () => telegramBot.stop("SIGTERM"));

  return telegramBot;
}

const args = process.argv.slice(2);
if (args[0] === "start") {
  try {
    await startTelegramBot();
  } catch (err) {
    console.error("[Telegram] Failed to start:", err.message);
    process.exit(1);
  }
}
