// Test de contrato del endpoint /bookmarks/import-batch (el que usa la
// extensión). Verifica: inserta nuevos, reporta duplicados en el segundo
// intento, respeta created_at, y limpia sus datos al final.
//
//   node scripts/test-import-contract.mjs [baseUrl]
//
// Requiere SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY en backend/.env
// (solo para la limpieza final y la verificación en DB).

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const BASE = process.argv[2] || "https://indexer-hzto.onrender.com";
const USER = "contract-test";
const NOW = Date.now();
const idA = `9${String(NOW).slice(-14)}01`;
const idB = `9${String(NOW).slice(-14)}02`;

let failures = 0;
function check(name, cond, extra = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function post(items) {
  const res = await fetch(`${BASE}/bookmarks/import-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: USER, source: "contract-test", items }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

const items = [
  {
    tweet_id: idA,
    text: "contract test A — network capture shape",
    url: `https://x.com/tester/status/${idA}`,
    author_handle: "tester",
    author_name: "Tester",
    created_at: "2026-01-15T10:00:00.000Z",
    links: ["https://github.com/octocat/hello-world"],
    first_comment_links: [],
    media: [],
  },
  {
    tweet_id: idB,
    text: "contract test B",
    url: `https://x.com/tester/status/${idB}`,
    author_handle: "tester",
    links: [],
    first_comment_links: [],
    media: [],
  },
  { tweet_id: "not-numeric", text: "invalid on purpose" },
];

console.log(`Contract test → ${BASE} (user=${USER})`);

// 1. Primer import: 2 nuevos + 1 inválido
const first = await post(items);
console.log("\n1) primer import");
check("HTTP 200", first.status === 200, `got ${first.status}`);
check("inserted=2", first.body.inserted === 2, `got ${first.body.inserted}`);
check("failed=1 (tweet_id inválido)", first.body.failed === 1, `got ${first.body.failed}`);
check("duplicates=0", first.body.duplicates === 0, `got ${first.body.duplicates}`);
check(
  "imported_ids contiene ambos",
  Array.isArray(first.body.imported_ids) &&
    first.body.imported_ids.includes(idA) &&
    first.body.imported_ids.includes(idB)
);

// 2. Re-import: todo duplicado
const second = await post(items.slice(0, 2));
console.log("\n2) re-import (idempotencia)");
check("inserted=0", second.body.inserted === 0, `got ${second.body.inserted}`);
check("duplicates=2", second.body.duplicates === 2, `got ${second.body.duplicates}`);

// 3. Verificación en DB: created_at respetado
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: rows } = await db
  .from("bookmarks")
  .select("tweet_id,created_at,author_username,links")
  .eq("user_id", USER);
console.log("\n3) verificación en DB");
check("2 filas en DB", (rows || []).length === 2, `got ${(rows || []).length}`);
const rowA = (rows || []).find((r) => r.tweet_id === idA);
check(
  "created_at preservado (2026-01-15)",
  Boolean(rowA?.created_at && rowA.created_at.startsWith("2026-01-15")),
  `got ${rowA?.created_at}`
);
check("author_username=tester", rowA?.author_username === "tester", `got ${rowA?.author_username}`);
check(
  "links preservados",
  Array.isArray(rowA?.links) && rowA.links.includes("https://github.com/octocat/hello-world")
);

// 4. Limpieza
const { error: delErr } = await db.from("bookmarks").delete().eq("user_id", USER);
console.log("\n4) limpieza:", delErr ? `ERROR ${delErr.message}` : "ok");

console.log(`\n${failures === 0 ? "✅ CONTRATO OK" : `❌ ${failures} fallos`}`);
process.exit(failures === 0 ? 0 : 1);
