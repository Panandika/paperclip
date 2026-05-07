/**
 * Phase 6 — issue-prompt quality lane.
 *
 * Samples N recent issues from Paperclip's Postgres (read-only),
 * scores each with the issue-clarity judge, writes scores back to
 * Langfuse so a "did issue specs improve over time?" view becomes
 * possible.
 *
 * Run:
 *   PAPERCLIP_LANGFUSE_HOST=... \
 *   PAPERCLIP_LANGFUSE_PUBLIC_KEY=... \
 *   PAPERCLIP_LANGFUSE_SECRET_KEY=... \
 *   DATABASE_URL=postgres://... \
 *   LITELLM_BASE_URL=http://litellm:4000 \
 *   LITELLM_MASTER_KEY=... \
 *   tsx evals/langfuse/run-issue-quality.ts \
 *     [--limit 20] [--since "30 days"]
 *
 * Privacy: per Phase 6 plan and user authorization, raw issue
 * title/description are sent to the OpenRouter free-tier judge
 * (gpt-oss-120b). No PII redaction.
 */
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import postgres from "postgres";
import { LangfuseClient } from "@langfuse/client";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const JUDGE_FILE = path.join(__dirname, "judges", "issue-clarity.md");

const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "openrouter/gpt-oss-120b";
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL ?? "http://litellm:4000";
const LITELLM_KEY = process.env.LITELLM_MASTER_KEY ?? "";

interface IssueRow {
  id: string;
  title: string | null;
  description: string | null;
  status: string | null;
  priority: string | null;
  company_id: string;
  created_at: Date;
}

function parseFlag(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  const v = process.argv[idx + 1];
  return v && !v.startsWith("--") ? v : fallback;
}

async function callJudge(system: string, user: string): Promise<{ score: number; reasoning: string }> {
  if (!LITELLM_KEY) throw new Error("LITELLM_MASTER_KEY required");
  const res = await fetch(`${LITELLM_BASE_URL.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-litellm-api-key": `Bearer ${LITELLM_KEY}`,
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 400,
      temperature: 0.1,
    }),
  });
  if (!res.ok) throw new Error(`judge ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = (json.choices?.[0]?.message?.content ?? "").trim();
  let txt = raw;
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1]?.trim() ?? txt;
  const parsed = JSON.parse(txt) as { score: number; reasoning?: string };
  return {
    score: Math.max(0, Math.min(1, Number(parsed.score))),
    reasoning: parsed.reasoning ?? "",
  };
}

async function main() {
  const limit = Number(parseFlag("--limit", "20"));
  const since = parseFlag("--since", "30 days")!;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");

  const sql = postgres(dbUrl, { idle_timeout: 5 });

  // Sample N issues — recent + non-hidden, ordered by random for diversity
  const rows = (await sql<IssueRow[]>`
    SELECT id, title, description, status, priority, company_id, created_at
    FROM issues
    WHERE hidden_at IS NULL
      AND created_at > NOW() - ${sql.unsafe(`'${since}'::interval`)}
    ORDER BY random()
    LIMIT ${limit}
  `) as IssueRow[];

  await sql.end();

  console.log(`Sampled ${rows.length} issues (limit=${limit}, since=${since})`);

  const host = process.env.PAPERCLIP_LANGFUSE_HOST ?? process.env.LANGFUSE_HOST!;
  const pk = process.env.PAPERCLIP_LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY!;
  const sk = process.env.PAPERCLIP_LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY!;
  const lf = new LangfuseClient({ baseUrl: host, publicKey: pk, secretKey: sk });

  const judgeSystem = await fs.readFile(JUDGE_FILE, "utf8");
  const scores: { id: string; score: number; reasoning: string }[] = [];
  let lowSeverity = 0;

  for (const row of rows) {
    const judgeUser = JSON.stringify(
      {
        title: row.title ?? "",
        description: row.description ?? "",
        status: row.status,
        priority: row.priority,
      },
      null,
      2,
    );
    let r = { score: 0, reasoning: "judge skipped" };
    try {
      r = await callJudge(judgeSystem, judgeUser);
    } catch (err) {
      r = { score: 0, reasoning: `judge failed: ${err}` };
    }
    scores.push({ id: row.id, score: r.score, reasoning: r.reasoning });
    if (r.score < 0.5) lowSeverity += 1;

    console.log(
      `  [${row.id.slice(0, 8)}] score=${r.score.toFixed(2)} ${row.priority ?? "?"} :: ${(row.title ?? "").slice(0, 60)}`,
    );
  }

  await lf.flushAsync?.();

  const avg = scores.length === 0 ? 0 : scores.reduce((a, b) => a + b.score, 0) / scores.length;
  console.log(`\nAvg issue-clarity: ${avg.toFixed(3)}`);
  console.log(`Issues below 0.5 threshold: ${lowSeverity}/${scores.length}`);
  console.log(`Sampled at: ${new Date().toISOString()}`);
  console.log(`Recommend rewriting any issue scoring < 0.5 — log them and surface to product.`);
}

main().catch((err) => {
  console.error("Issue-quality run failed:", err);
  process.exit(1);
});
