/**
 * Phase 4b-alt — sync Langfuse prompts to runtime agent bundles.
 *
 * Polls Langfuse for `agent/{role}` prompts at label `production`, and
 * for each Paperclip agent whose `role` matches, writes the latest
 * content to its managed instructions bundle entry file.
 *
 * Designed to run on a 60-second cron / systemd-timer cadence.
 *
 * Idempotent — version cache at /var/lib/paperclip-prompts/.versions.json
 * skips writes when Langfuse `version` integer is unchanged.
 *
 * Run:
 *   PAPERCLIP_LANGFUSE_HOST=... \
 *   PAPERCLIP_LANGFUSE_PUBLIC_KEY=... \
 *   PAPERCLIP_LANGFUSE_SECRET_KEY=... \
 *   DATABASE_URL=postgres://... \
 *   PAPERCLIP_HOME=/paperclip/instances/default \
 *   tsx server/scripts/sync-prompts-from-langfuse.ts
 *
 * Env knobs:
 *   PAPERCLIP_PROMPT_SYNC_DISABLED=1     hard off
 *   PAPERCLIP_PROMPT_SYNC_LABEL=staging  override label (default production)
 *   PAPERCLIP_PROMPT_SYNC_VERSIONS_FILE  override cache location
 */
import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { LangfuseClient } from "@langfuse/client";

const LABEL = process.env.PAPERCLIP_PROMPT_SYNC_LABEL ?? "production";
const VERSIONS_FILE =
  process.env.PAPERCLIP_PROMPT_SYNC_VERSIONS_FILE ??
  "/var/lib/paperclip-prompts/.versions.json";

interface AgentRow {
  id: string;
  company_id: string;
  role: string | null;
  name: string;
}

interface VersionCache {
  // role -> langfuse version int
  [role: string]: number;
}

function instanceRoot(): string {
  // Mirrors server/src/home-paths.ts:resolvePaperclipInstanceRoot.
  // Default lives at $HOME/.paperclip/instances/default for dev runs;
  // inside the docker-server-1 container it's /paperclip/instances/default
  // (volume bind). PAPERCLIP_HOME overrides explicitly.
  const envHome = process.env.PAPERCLIP_HOME?.trim();
  const inst = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  if (envHome) return path.resolve(envHome, "instances", inst);
  const home = process.env.HOME ?? "/tmp";
  return path.resolve(home, ".paperclip", "instances", inst);
}

function bundleEntryPath(companyId: string, agentId: string): string {
  return path.resolve(
    instanceRoot(),
    "companies",
    companyId,
    "agents",
    agentId,
    "instructions",
    "AGENTS.md",
  );
}

async function loadVersionCache(): Promise<VersionCache> {
  try {
    const text = await fs.readFile(VERSIONS_FILE, "utf8");
    return JSON.parse(text) as VersionCache;
  } catch {
    return {};
  }
}

async function saveVersionCache(cache: VersionCache): Promise<void> {
  await fs.mkdir(path.dirname(VERSIONS_FILE), { recursive: true });
  await fs.writeFile(VERSIONS_FILE, JSON.stringify(cache, null, 2) + "\n");
}

async function atomicWriteFile(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, content, "utf8");
  // fsync the file before rename per node-fs best practices
  const fh = await fs.open(tmp, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, target);
  // fsync the parent directory too — tolerated to be a no-op on some FS
  try {
    const dirFh = await fs.open(path.dirname(target), "r");
    try {
      await dirFh.sync();
    } finally {
      await dirFh.close();
    }
  } catch {
    // some filesystems don't permit fsync on directories — fine to skip
  }
}

async function main() {
  if (process.env.PAPERCLIP_PROMPT_SYNC_DISABLED === "1") {
    console.log("[prompt-sync] disabled via PAPERCLIP_PROMPT_SYNC_DISABLED");
    return;
  }

  const host = process.env.PAPERCLIP_LANGFUSE_HOST ?? process.env.LANGFUSE_HOST;
  const pk = process.env.PAPERCLIP_LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.PAPERCLIP_LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY;
  const dbUrl = process.env.DATABASE_URL;

  if (!host || !pk || !sk) {
    console.error("[prompt-sync] missing Langfuse credentials");
    process.exit(2);
  }
  if (!dbUrl) {
    console.error("[prompt-sync] missing DATABASE_URL");
    process.exit(2);
  }

  const lf = new LangfuseClient({ baseUrl: host, publicKey: pk, secretKey: sk });
  const sql = postgres(dbUrl, { idle_timeout: 5 });

  // 1. Discover roles in the system. Pull distinct, non-null roles.
  const roles = (await sql<{ role: string }[]>`SELECT DISTINCT role FROM agents WHERE role IS NOT NULL`).map((r) => r.role);
  if (roles.length === 0) {
    console.log("[prompt-sync] no agents with roles; nothing to do");
    await sql.end();
    return;
  }

  const cache = await loadVersionCache();
  const updates: { role: string; version: number; content: string }[] = [];

  for (const role of roles) {
    const promptName = `agent/${role}`;
    let prompt;
    try {
      prompt = await lf.prompt.get(promptName, { label: LABEL });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
        // No prompt for this role yet; skip silently.
        continue;
      }
      console.warn(`[prompt-sync] ${promptName}: fetch failed: ${msg}`);
      continue;
    }
    const version = (prompt as { version?: number }).version;
    const content = (prompt as { prompt?: string }).prompt;
    if (typeof version !== "number" || typeof content !== "string") {
      console.warn(`[prompt-sync] ${promptName}: malformed prompt object`);
      continue;
    }
    if (cache[role] === version) {
      // No change — skip writes
      continue;
    }
    updates.push({ role, version, content });
  }

  if (updates.length === 0) {
    console.log(`[prompt-sync] all roles up-to-date (${roles.length} roles checked)`);
    await sql.end();
    return;
  }

  // 2. For each updated role, fan out to all agents with that role.
  for (const { role, version, content } of updates) {
    const agents = await sql<AgentRow[]>`
      SELECT id, company_id, role, name
      FROM agents
      WHERE role = ${role}
    `;
    let written = 0;
    for (const agent of agents) {
      try {
        const target = bundleEntryPath(agent.company_id, agent.id);
        // Verify the bundle dir exists (i.e. agent has been materialized).
        // If not, skip — agent will pick up the new prompt at materialization.
        try {
          await fs.access(path.dirname(target));
        } catch {
          continue;
        }
        await atomicWriteFile(target, content);
        written += 1;
      } catch (err) {
        console.warn(`[prompt-sync] ${agent.id} (${agent.name}): write failed: ${err}`);
      }
    }
    cache[role] = version;
    console.log(`[prompt-sync] agent/${role} v${version} -> ${written}/${agents.length} agents`);
  }

  await saveVersionCache(cache);
  await sql.end();
  console.log(`[prompt-sync] done (${updates.length} role updates applied)`);
}

main().catch((err) => {
  console.error("[prompt-sync] fatal:", err);
  process.exit(1);
});
