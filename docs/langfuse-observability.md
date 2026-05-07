# Langfuse Observability (thinkpad fork)

Self-hosted Langfuse integration for Paperclip — tracing every heartbeat
run + LLM call, versioning per-role system prompts, and running
LLM-as-judge evals against datasets and production traffic.

This is a thinkpad-branch-only feature. Upstream `paperclipai/paperclip`
does not have any of these files.

## Architecture

```
┌──────────────────────────────────┐
│   Paperclip server               │   server/src/services/observability/langfuse.ts
│   ─ executeRun() spawns trace ───┼──→  Langfuse OTel exporter (NodeSDK)
│   ─ /heartbeat-runs/:runId       │
│     returns langfuseTraceUrl     │
└──────────────────────────────────┘                   │
                                                       ▼
┌──────────────────────────────────┐         ┌─────────────────────┐
│   litellm proxy                  │         │   Langfuse v3       │
│   success_callback: ['langfuse'] ┼────────→│   (self-hosted,     │
│   every chat/completion          │         │   port 3002)        │
│   emits a generation             │         │                     │
└──────────────────────────────────┘         │   Traces / Prompts  │
                                             │   Scores / Datasets │
┌──────────────────────────────────┐         └─────────────────────┘
│   Eval scripts (offline)         │                   ▲
│   pnpm evals:langfuse            │                   │
│   pnpm evals:online-judges       ┼───── judges ──────┘
│   pnpm evals:issue-quality       │
└──────────────────────────────────┘

┌──────────────────────────────────┐
│   Prompts syncer (systemd 60s)   │
│   server/scripts/                │
│   sync-prompts-from-langfuse.ts  ┼──── reads agent/{role} ──────┐
│                                  │     at label=production       ▼
└──────────────────────────────────┘                       writes per-agent
                                                            AGENTS.md to
                                                            instance bundle
```

## What's in the repo

| Path | Phase | Purpose |
|---|---|---|
| `docker/docker-compose.override.yml` | 3a | `PAPERCLIP_LANGFUSE_*` env + `docker_default` network |
| `server/src/services/observability/langfuse.ts` | 3a, 3b | OTel singleton + `langfuseTraceUrl(runId)` helper |
| `server/src/services/heartbeat.ts` (lines around 6484, 7165, 3618) | 3a | `executeRun()` wrapped with `startRunTrace` + `lfRun.end` in finally |
| `server/src/routes/agents.ts` (around 3170) | 3b | `/heartbeat-runs/:runId` returns `langfuseTraceUrl` |
| `server/scripts/migrate-prompts-to-langfuse.ts` | 4a | one-shot disk → Langfuse |
| `server/scripts/sync-prompts-from-langfuse.ts` | 4b-alt | runtime Langfuse → live agent bundles |
| `evals/langfuse/datasets/*.jsonl` | 5a | dataset items |
| `evals/langfuse/judges/*.md` | 5a/5b | LLM-as-judge rubrics |
| `evals/langfuse/run-experiment.ts` | 5a/5b | offline system-prompt eval runner |
| `evals/langfuse/run-online-judges.ts` | 5c | poll prod traces, sample, score |
| `evals/langfuse/run-issue-quality.ts` | 6 | nightly issue-spec audit |
| `evals/langfuse/baseline.json` | 5b | regression reference |
| `skills/paperclip-manage-prompts/` | 4c | CEO-agent skill: list/get/create/promote prompts |

Operational details (host paths, systemd units, runbooks) live in
`~/thinkpad-ops/langfuse-runbook.md` (host-only, not in this repo).

## Env vars

All optional in dev — Langfuse code is gated and turns into a no-op
when keys are absent.

| Var | Purpose |
|---|---|
| `PAPERCLIP_LANGFUSE_HOST` | Langfuse internal URL (e.g. `http://langfuse-web:3000`) |
| `PAPERCLIP_LANGFUSE_PUBLIC_KEY` | project public key |
| `PAPERCLIP_LANGFUSE_SECRET_KEY` | project secret key |
| `PAPERCLIP_LANGFUSE_DISABLED` | set to `1` to short-circuit |
| `PAPERCLIP_LANGFUSE_PUBLIC_URL` | UI-facing URL for `traceUrl` deep-links |
| `PAPERCLIP_LANGFUSE_PROJECT_ID` | trace URL slug (default `paperclip`) |
| `PAPERCLIP_PROMPT_SYNC_DISABLED` | set to `1` to disable runtime syncer |
| `PAPERCLIP_PROMPT_SYNC_LABEL` | which Langfuse label to track (default `production`) |

## Run an eval

```bash
pnpm evals:langfuse                    # offline system-prompt eval
pnpm evals:online-judges -- --since "1 hour" --sample 0.3
pnpm evals:issue-quality
```

Each writes traces + scores to Langfuse. Browse via Tailscale at
`http://100.125.53.66:3002` (project: `paperclip`).

## Edit a prompt

```bash
# Via skill
skills/paperclip-manage-prompts/references/get-prompt.sh agent/ceo > /tmp/edit-ceo.md
$EDITOR /tmp/edit-ceo.md
skills/paperclip-manage-prompts/references/create-prompt-version.sh agent/ceo /tmp/edit-ceo.md "msg"
PAPERCLIP_EVAL_PROMPT_LABEL=staging pnpm evals:langfuse
skills/paperclip-manage-prompts/references/promote-prompt.sh agent/ceo
```

After promotion, the systemd-timer-driven syncer (host:
`~/thinkpad-ops/systemd/paperclip-prompts-sync.sh`) writes the new
text to every live CEO agent's bundle within 60 s.

## Why polling instead of webhook (for now)

Plan-validation phase considered Langfuse → GitHub webhook + auto-merge
with eval-CI gate. Rejected for v0 because the eval CI requires a
self-hosted GitHub runner with access to the ThinkPad's internal
network — extra setup that doesn't pull weight given run-boundary
semantics make sub-second propagation unnecessary. Polling at 60s
is good enough; webhook is tracked as a future improvement.

## Why disk-as-runtime instead of resolver fetch (4b-alt vs 4b-full)

The agent-instructions resolver in `server/src/services/agent-instructions.ts`
has many file-tree assumptions that would have rippled through bundle
mode validators, db schema, UI selectors, and adapter spawn paths.
4b-alt (a polling syncer that overwrites disk) achieves the user-facing
behavior — non-engineer prompt edits land in production within a minute —
without that refactor. Tradeoff: there's now a window where disk and
Langfuse can diverge if the syncer fails; mitigated by running on a
60s timer and exiting non-zero on errors so journalctl surfaces them.

## What's NOT here

- Langfuse Datasets API (v5 SDK has different shape; deferred to 5b-full)
- eval-mock adapter package (would let evals run through real Paperclip
  governance context; deferred to 5b-full)
- Webhook-based prompt sync (currently polling)
- CI integration (`pnpm evals:langfuse` as a required GitHub check
  before merging prompt changes)
- Multi-tenant per-company prompt overrides
- Prompt-experiment linkage (so `v7 vs v8` score deltas land in
  Langfuse Experiments view automatically)

These are future phases — the current setup is functionally complete
for single-tenant multi-agent observability + prompt management.
