/**
 * Phase 5c — online judges via Langfuse public API.
 *
 * Self-hosted Langfuse v3 doesn't expose Evaluator config over the
 * public API. This script approximates online evaluation: poll
 * recent traces, sample a configurable fraction, run our local
 * judges, and POST scores back to /api/public/scores so they
 * surface in the Langfuse Scores tab + per-trace detail view.
 *
 * Runs as a cron-able job. Tracks last-processed timestamp in
 * baseline/online-cursor.json so each tick only sees new traces.
 *
 * Run:
 *   pnpm evals:online-judges
 *   pnpm evals:online-judges -- --since "1 hour" --sample 0.5
 */
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { LangfuseClient } from "@langfuse/client";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const JUDGE_ROOT = path.join(__dirname, "judges");
const CURSOR_FILE = path.join(__dirname, "online-cursor.json");

const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL ?? "http://litellm:4000";
const LITELLM_KEY = process.env.LITELLM_MASTER_KEY ?? "";
// Cheaper model for online sampling per Phase 5b plan (Haiku in production,
// gpt-oss-120b for free homelab tier)
const JUDGE_MODEL = process.env.EVAL_ONLINE_JUDGE_MODEL ?? "openrouter/gpt-oss-120b";

interface Trace {
  id: string;
  name: string;
  timestamp: string;
  input: unknown;
  output: unknown;
  metadata: Record<string, unknown> | null;
}

function parseFlag(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  const v = process.argv[idx + 1];
  return v && !v.startsWith("--") ? v : fallback;
}

async function loadCursor(): Promise<string | null> {
  try {
    const text = await fs.readFile(CURSOR_FILE, "utf8");
    const parsed = JSON.parse(text) as { lastTimestamp?: string };
    return parsed.lastTimestamp ?? null;
  } catch {
    return null;
  }
}

async function saveCursor(ts: string): Promise<void> {
  await fs.writeFile(CURSOR_FILE, JSON.stringify({ lastTimestamp: ts }, null, 2) + "\n");
}

async function callJudge(system: string, user: string): Promise<{ score: number; reasoning: string }> {
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
  if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  let txt = (json.choices?.[0]?.message?.content ?? "").trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1]?.trim() ?? txt;
  const parsed = JSON.parse(txt) as { score: number; reasoning?: string };
  return {
    score: Math.max(0, Math.min(1, Number(parsed.score))),
    reasoning: parsed.reasoning ?? "",
  };
}

async function main() {
  const since = parseFlag("--since", "1 hour")!;
  const sampleRate = Number(parseFlag("--sample", "0.5"));
  const judgeFilter = (parseFlag("--judges") ?? "governance,progress,tool-correctness").split(",");

  const host = process.env.PAPERCLIP_LANGFUSE_HOST ?? process.env.LANGFUSE_HOST!;
  const pk = process.env.PAPERCLIP_LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY!;
  const sk = process.env.PAPERCLIP_LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY!;
  const auth = Buffer.from(`${pk}:${sk}`).toString("base64");
  const lf = new LangfuseClient({ baseUrl: host, publicKey: pk, secretKey: sk });

  const judgeNames = (await fs.readdir(JUDGE_ROOT))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .filter((j) => judgeFilter.includes(j));
  const judgeSystems: Record<string, string> = {};
  for (const j of judgeNames) {
    judgeSystems[j] = await fs.readFile(path.join(JUDGE_ROOT, `${j}.md`), "utf8");
  }
  console.log(`Online judges: ${judgeNames.join(", ")}`);
  console.log(`Sample rate: ${sampleRate} | since: ${since}`);

  const cursor = await loadCursor();
  const fromTs = cursor ?? new Date(Date.now() - parseSince(since)).toISOString();
  console.log(`Polling traces since ${fromTs}`);

  // Pull traces (paginate up to 200)
  const tracesUrl = `${host.replace(/\/+$/, "")}/api/public/traces?fromTimestamp=${encodeURIComponent(fromTs)}&limit=100`;
  const tracesRes = await fetch(tracesUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!tracesRes.ok) throw new Error(`trace fetch ${tracesRes.status}`);
  const tracesJson = (await tracesRes.json()) as { data: Trace[] };
  const traces = tracesJson.data;

  if (traces.length === 0) {
    console.log("No new traces.");
    return;
  }

  console.log(`Found ${traces.length} new traces; sampling at ${sampleRate}`);

  let scored = 0;
  for (const t of traces) {
    if (Math.random() > sampleRate) continue;
    if (!t.input || !t.output) continue;

    const judgeUser = JSON.stringify(
      {
        issue: { title: "(prod trace)", description: JSON.stringify(t.input).slice(0, 1500) },
        expectedBehavior: { rubricNotes: "production trace; no specific rubric — score per judge dimension defaults" },
        agentResponse: typeof t.output === "string" ? t.output : JSON.stringify(t.output).slice(0, 2000),
      },
      null,
      2,
    );

    for (const judgeName of judgeNames) {
      try {
        const r = await callJudge(judgeSystems[judgeName]!, judgeUser);
        await fetch(`${host.replace(/\/+$/, "")}/api/public/scores`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
          body: JSON.stringify({
            traceId: t.id,
            name: `online.${judgeName}`,
            value: r.score,
            comment: r.reasoning.slice(0, 400),
            dataType: "NUMERIC",
          }),
        });
      } catch (err) {
        console.warn(`  [${t.id.slice(0, 8)}] ${judgeName} failed: ${err}`);
      }
    }
    scored += 1;
  }

  const lastTs = traces[traces.length - 1]?.timestamp;
  if (lastTs) await saveCursor(lastTs);

  await lf.flushAsync?.();
  console.log(`Scored ${scored}/${traces.length} traces. Cursor advanced to ${lastTs}`);
}

function parseSince(spec: string): number {
  // "1 hour", "30 days", "15 minutes", etc.
  const m = spec.trim().match(/^(\d+)\s*(minute|hour|day)s?$/i);
  if (!m) return 60 * 60 * 1000;
  const n = Number(m[1]);
  switch (m[2]?.toLowerCase()) {
    case "minute": return n * 60 * 1000;
    case "hour": return n * 60 * 60 * 1000;
    case "day": return n * 24 * 60 * 60 * 1000;
    default: return 60 * 60 * 1000;
  }
}

main().catch((err) => {
  console.error("Online judges failed:", err);
  process.exit(1);
});
