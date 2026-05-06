/**
 * One-shot migration: upload Paperclip per-role AGENTS.md files to
 * Langfuse Prompt Management. Each role becomes a versioned prompt
 * named `agent/{role}` with label `production`.
 *
 * Run: pnpm prompts:migrate-langfuse
 *
 * Requires PAPERCLIP_LANGFUSE_HOST + PUBLIC_KEY + SECRET_KEY in env.
 *
 * Idempotent: re-running creates a new version only if the text differs
 * from the latest production version (Langfuse SDK dedupes identical
 * content under the same name + label).
 */
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { LangfuseClient } from "@langfuse/client";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ASSETS_ROOT = path.resolve(__dirname, "../src/onboarding-assets");

interface RoleSource {
  role: string;
  filePath: string;
}

async function listRoles(): Promise<RoleSource[]> {
  const entries = await fs.readdir(ASSETS_ROOT, { withFileTypes: true });
  const roles: RoleSource[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(ASSETS_ROOT, entry.name, "AGENTS.md");
    try {
      await fs.access(file);
      roles.push({ role: entry.name, filePath: file });
    } catch {
      // skip dirs without AGENTS.md
    }
  }
  return roles;
}

async function main() {
  const host = process.env.PAPERCLIP_LANGFUSE_HOST ?? process.env.LANGFUSE_HOST;
  const pk = process.env.PAPERCLIP_LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.PAPERCLIP_LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY;

  if (!host || !pk || !sk) {
    console.error(
      "Missing Langfuse credentials. Set PAPERCLIP_LANGFUSE_HOST, _PUBLIC_KEY, _SECRET_KEY.",
    );
    process.exit(2);
  }

  // Map to native env names for the SDK
  process.env.LANGFUSE_HOST = host;
  process.env.LANGFUSE_PUBLIC_KEY = pk;
  process.env.LANGFUSE_SECRET_KEY = sk;

  const client = new LangfuseClient({ baseUrl: host, publicKey: pk, secretKey: sk });

  const roles = await listRoles();
  if (roles.length === 0) {
    console.warn(`No AGENTS.md files found under ${ASSETS_ROOT}`);
    return;
  }

  console.log(`Migrating ${roles.length} role prompts to Langfuse at ${host}`);

  for (const { role, filePath } of roles) {
    const content = await fs.readFile(filePath, "utf8");
    const name = `agent/${role}`;

    let latestText: string | null = null;
    try {
      const existing = await client.prompt.get(name, { label: "production" });
      latestText = typeof existing.prompt === "string" ? existing.prompt : null;
    } catch {
      // No prior version — first migration
    }

    if (latestText === content) {
      console.log(`  • ${name}: unchanged, skipping`);
      continue;
    }

    await client.prompt.create({
      name,
      type: "text",
      prompt: content,
      labels: ["production"],
      tags: ["paperclip", `role:${role}`],
      commitMessage: latestText === null
        ? "initial migration from disk"
        : "sync from disk (paperclip thinkpad)",
    });
    console.log(`  • ${name}: uploaded ${content.length} chars (${filePath})`);
  }

  // Ensure spans/prompt cache flush before exit
  await client.flushAsync?.();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
