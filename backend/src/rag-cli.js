import dotenv from "dotenv";
dotenv.config();

import readline from "node:readline";
import { ragSearch, getTopTrustScores, getRepoTrustScores } from "./rag-orchestrator.js";
import { getPineconeStats } from "./rag-pinecone.js";
import { createClient } from "@supabase/supabase-js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const startedAt = Date.now();

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  return createClient(url, key);
}

function printHelp() {
  console.log(`
📚 Indexer RAG CLI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Commands:
  /search <query>          Search bookmarks and READMEs
  /filter bookmark <query> Search only bookmarks
  /filter readme <query>   Search only READMEs
  /trust <repo>            Show trust score for a repo
  /top                     Show top repos by trust score
  /data                    Show available data sources
  /status                  Show system status
  /help                    Show this help
  /quit                    Exit

Examples:
  /search ai agents tools
  /filter bookmark react hooks
  /filter readme supabase auth
  `);
}

function formatResults(results) {
  let output = `\n🔍 "${results.query}"\n`;
  output += `   ${results.total} resultados | ${results.latency_ms}ms\n`;
  output += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";

  if (results.results.length === 0) {
    output += "  No se encontraron resultados.\n";
    return output;
  }

  results.results.forEach((r, i) => {
    const score = (r.score * 100).toFixed(0);
    const icon = r.source_type === "readme" ? "📦" : "🔖";
    
    let repoName = "";
    if (r.url && r.url.includes("github.com")) {
      const match = r.url.match(/github\.com\/([^/]+\/[^/]+)/);
      if (match) repoName = match[1];
    }
    
    output += `${icon} ${i + 1}. ${repoName || r.title}\n`;
    output += `   📊 ${score}% relevancia`;
    if (r.trust_score != null && r.trust_score > 0) {
      output += ` | ⭐ ${r.trust_score}/10  ❤️ ${r.avg_likes}  💾 ${r.avg_saves}`;
    }
    output += "\n";
    
    if (r.url) output += `   🔗 ${r.url}\n`;
    if (r.author && r.author !== repoName) output += `   👤 ${r.author}\n`;
    if (r.tags && r.tags.length > 0) output += `   🏷️  ${r.tags.join(", ")}\n`;
    
    let text = r.text
      .replace(/Author:.*?\n/g, "")
      .replace(/URL:.*?\n/g, "")
      .replace(/\n+/g, " ")
      .trim();
    
    if (text.length > 150) text = text.slice(0, 147) + "...";
    output += `   📝 ${text}\n\n`;
  });

  return output;
}

async function printData() {
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

  console.log(`
📊 Available Data Sources
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔖 Bookmarks
   Total: ${bmCount || 0}
   Indexed: ${bmSync || 0} chunks

📦 GitHub READMEs
   Repos: ${uniqueRepos.size}
   Indexed: ${rmSync || 0} chunks
  `);
}

async function printStatus() {
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

  console.log(`
📈 System Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⏱ CLI uptime: ${uptimeStr}

🌲 Pinecone
   Vectors: ${pineconeStats?.totalRecordCount || 0}
   Dimension: ${pineconeStats?.dimension || 1536}
   Namespaces: ${Object.keys(pineconeStats?.namespaces || {}).length}

🔄 Sync
   Bookmarks: ${bmSync || 0} chunks
   READMEs: ${rmSync || 0} chunks
  `);
}

async function processCommand(input) {
  const trimmed = input.trim();

  if (!trimmed) return;

  if (trimmed === "/quit" || trimmed === "/exit") {
    console.log("👋 Bye!");
    process.exit(0);
  }

  if (trimmed === "/help") {
    printHelp();
    return;
  }

  if (trimmed === "/data") {
    try {
      await printData();
    } catch (err) {
      console.error("❌ Error:", err.message);
    }
    return;
  }

  if (trimmed === "/status") {
    try {
      await printStatus();
    } catch (err) {
      console.error("❌ Error:", err.message);
    }
    return;
  }

  if (trimmed.startsWith("/trust ")) {
    let slug = trimmed.replace("/trust ", "").trim().toLowerCase();
    if (slug.includes("github.com/")) {
      slug = slug.match(/github\.com\/([^/]+\/[^/?#]+)/i)?.[1] || slug;
    }
    try {
      const scores = await getRepoTrustScores([slug]);
      const ts = scores[slug];
      if (!ts || ts.trust_score == null || ts.trust_score <= 0) {
        console.log(`❌ No trust score data for "${slug}"`);
      } else {
        const bar = "█".repeat(Math.round(ts.trust_score / 2)) + "░".repeat(5 - Math.round(ts.trust_score / 2));
        console.log(`\n⭐ Trust Score: ${slug}`);
        console.log(`   ${bar} ${ts.trust_score}/10\n`);
        console.log("   📊 Breakdown:");
        console.log(`      ❤️  Avg likes:        ${ts.avg_likes}`);
        console.log(`      💾  Avg saves:        ${ts.avg_saves}`);
        console.log(`      📢  Mentions:         ${ts.mentions_count}`);
        console.log(`      📈  Engagement rate:  ${ts.avg_engagement_rate}%`);
        console.log(`      🔗  Source:            ${ts.source_url}`);
      }
    } catch (err) {
      console.error("❌ Error:", err.message);
    }
    return;
  }

  if (trimmed === "/top") {
    try {
      const tops = await getTopTrustScores(10);
      if (!tops || tops.length === 0) {
        console.log("No trust score data available.");
        return;
      }
      console.log("\n🏆 Top 10 — Trust Score\n");
      tops.forEach((r, i) => {
        const bar = "█".repeat(Math.round(r.trust_score / 2)) + "░".repeat(5 - Math.round(r.trust_score / 2));
        console.log(`${i + 1}. ${r.repo_slug}`);
        console.log(`   ${bar} ${r.trust_score}/10  ❤️ ${r.avg_likes}  💾 ${r.avg_saves}`);
      });
    } catch (err) {
      console.error("❌ Error:", err.message);
    }
    return;
  }

  if (trimmed.startsWith("/search ")) {
    const query = trimmed.replace("/search ", "").trim();
    if (!query) {
      console.log("Usage: /search <query>");
      return;
    }

    try {
      const results = await ragSearch(query, { topK: 5, interface: "cli" });
      console.log(formatResults(results));
    } catch (err) {
      console.error("❌ Error:", err.message);
    }
    return;
  }

  if (trimmed.startsWith("/filter ")) {
    const parts = trimmed.replace("/filter ", "").trim().split(" ");
    const sourceType = parts[0];
    const query = parts.slice(1).join(" ");

    if (!["bookmark", "readme"].includes(sourceType) || !query) {
      console.log("Usage: /filter <bookmark|readme> <query>");
      return;
    }

    try {
      const results = await ragSearch(query, { topK: 5, sourceType, interface: "cli" });
      console.log(formatResults(results));
    } catch (err) {
      console.error("❌ Error:", err.message);
    }
    return;
  }

  try {
    const results = await ragSearch(trimmed, { topK: 5, interface: "cli" });
    console.log(formatResults(results));
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

function prompt() {
  rl.question("🔎 > ", async (input) => {
    await processCommand(input);
    prompt();
  });
}

console.log("📚 Indexer RAG CLI v1.0.0");
console.log("Type /help for commands, /quit to exit.\n");

const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0) {
  const command = cliArgs.join(" ");
  processCommand(command).then(() => process.exit(0));
} else {
  prompt();
}
