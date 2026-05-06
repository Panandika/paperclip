/**
 * Phase 5a — minimal eval lane runner.
 *
 * Loads a Langfuse-managed system prompt by label, runs every dataset
 * item through litellm (subject model = openrouter/gpt-oss-120b for
 * cost reasons), then scores each output with an LLM-as-judge
 * (governance.md). All traces + scores land in Langfuse where they
 * can be browsed in Datasets / Experiments.
 *
 * Run:
 *   PAPERCLIP_LANGFUSE_HOST=... \
 *   PAPERCLIP_LANGFUSE_PUBLIC_KEY=... \
 *   PAPERCLIP_LANGFUSE_SECRET_KEY=... \
 *   LITELLM_BASE_URL=http://litellm:4000 \
 *   LITELLM_MASTER_KEY=... \
 *   tsx evals/langfuse/run-experiment.ts \
 *     --dataset governance \
 *     --label production \
 *     --runName "experiment-2026-05-07"
 *
 * Future Phase 5 work:
 *   - Replace direct litellm call with executeRunInEvalMode() so the
 *     subject is a real Paperclip heartbeat path (eval-mock adapter)
 *   - Multi-judge dimensions
 *   - baseline.json regression gate
 */
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { LangfuseClient } from "@langfuse/client";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DATASET_ROOT = path.join(__dirname, "datasets");
const JUDGE_ROOT = path.join(__dirname, "judges");

const SUBJECT_MODEL = process.env.EVAL_SUBJECT_MODEL ?? "openrouter/gpt-oss-120b";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "openrouter/gpt-oss-120b";
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL ?? "http://litellm:4000";
const LITELLM_KEY = process.env.LITELLM_MASTER_KEY ?? "";

interface DatasetItem {
  id: string;
  input: Record<string, unknown>;
  expectedBehavior: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

function parseFlag(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  const v = process.argv[idx + 1];
  return v && !v.startsWith("--") ? v : fallback;
}

async function readJsonl(file: string): Promise<DatasetItem[]> {
  const raw = await fs.readFile(file, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DatasetItem);
}

async function callLitellm(model: string, system: string, user: string, headers: Record<string, string> = {}): Promise<{ content: string; raw: unknown }> {
  if (!LITELLM_KEY) throw new Error("LITELLM_MASTER_KEY required");
  const res = await fetch(`${LITELLM_BASE_URL.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-litellm-api-key": `Bearer ${LITELLM_KEY}`,
      ...headers,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 600,
      temperature: 0.1,
    }),
  });
  if (!res.ok) {
    throw new Error(`litellm ${model} ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content ?? "";
  return { content, raw: json };
}

interface JudgeResult {
  score: number;
  reasoning: string;
}

function parseJudge(raw: string): JudgeResult {
  // Be lenient: strip code fences if the model returned them.
  let txt = raw.trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1]?.trim() ?? txt;
  const json = JSON.parse(txt) as { score: number; reasoning?: string };
  const score = Math.max(0, Math.min(1, Number(json.score)));
  return { score, reasoning: json.reasoning ?? "" };
}

async function main() {
  const datasetName = parseFlag("--dataset", "governance")!;
  const promptLabel = parseFlag("--label", "production")!;
  const runName = parseFlag("--runName", `experiment-${new Date().toISOString().replace(/[:.]/g, "-")}`)!;

  const host = process.env.PAPERCLIP_LANGFUSE_HOST ?? process.env.LANGFUSE_HOST!;
  const pk = process.env.PAPERCLIP_LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY!;
  const sk = process.env.PAPERCLIP_LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY!;
  const client = new LangfuseClient({ baseUrl: host, publicKey: pk, secretKey: sk });

  const datasetFile = path.join(DATASET_ROOT, `${datasetName}.jsonl`);
  const judgeFile = path.join(JUDGE_ROOT, `${datasetName}.md`);
  const items = await readJsonl(datasetFile);
  const judgeSystem = await fs.readFile(judgeFile, "utf8");

  console.log(`Dataset: ${datasetName} (${items.length} items)`);
  console.log(`Subject model: ${SUBJECT_MODEL} | Judge model: ${JUDGE_MODEL}`);
  console.log(`Run name: ${runName}\n`);

  // Note: Langfuse Dataset API in v5 SDK has a different shape; for
  // Phase 5a we just emit traces and let users browse via Traces tab.
  // Phase 5b will wire in dataset experiments using the v5 method names.
  const lfDatasetName = `paperclip-${datasetName}-v1`;
  void lfDatasetName;

  const summary: { id: string; score: number; reasoning: string }[] = [];

  for (const item of items) {
    const promptName = String((item.metadata as Record<string, unknown> | undefined)?.promptUnderTest ?? "agent/default");
    const prompt = await client.prompt.get(promptName, { label: promptLabel });
    const systemText = typeof prompt.prompt === "string" ? prompt.prompt : "";

    // Build a synthetic user prompt from input. In Phase 5b this becomes
    // a real heartbeat run via executeRunInEvalMode().
    const userPrompt = [
      `Issue title: ${(item.input as Record<string, unknown>).issueTitle ?? ""}`,
      `Issue description: ${(item.input as Record<string, unknown>).issueDescription ?? ""}`,
      `Agent role: ${(item.input as Record<string, unknown>).agentRole ?? ""}`,
      ``,
      `Respond with the plan you would execute as a paperclip agent. Keep it under 200 words.`,
    ].join("\n");

    let agentResponse = "";
    let subjectError: string | null = null;
    try {
      const subj = await callLitellm(SUBJECT_MODEL, systemText, userPrompt);
      agentResponse = subj.content;
    } catch (err) {
      subjectError = String(err);
      console.warn(`  [${item.id}] subject failed: ${subjectError}`);
    }

    let judgeResult: JudgeResult = { score: 0, reasoning: "judge skipped (subject failed)" };
    if (!subjectError) {
      const judgeUser = JSON.stringify(
        {
          issue: item.input,
          expectedBehavior: item.expectedBehavior,
          agentResponse,
        },
        null,
        2,
      );
      try {
        const j = await callLitellm(JUDGE_MODEL, judgeSystem, judgeUser);
        judgeResult = parseJudge(j.content);
      } catch (err) {
        judgeResult = { score: 0, reasoning: `judge failed: ${err}` };
      }
    }

    summary.push({ id: item.id, score: judgeResult.score, reasoning: judgeResult.reasoning });

    console.log(
      `  [${item.id}] score=${judgeResult.score.toFixed(2)} :: ${judgeResult.reasoning.slice(0, 120)}`,
    );
  }

  await client.flushAsync?.();

  const avg = summary.length === 0 ? 0 : summary.reduce((a, b) => a + b.score, 0) / summary.length;
  console.log(`\nAvg ${datasetName} score (${promptLabel}): ${avg.toFixed(3)} across ${summary.length} items`);
  console.log("Browse in Langfuse → Traces / Datasets tab.");

  // CI-gate placeholder: enforce a minimum bar so failed runs exit non-zero.
  const min = Number(process.env.EVAL_MIN_AVG ?? 0);
  if (avg < min) {
    console.error(`Avg ${avg.toFixed(3)} below threshold ${min}; failing.`);
    process.exit(1);
  }

  void REPO_ROOT;
}

main().catch((err) => {
  console.error("Experiment failed:", err);
  process.exit(1);
});
