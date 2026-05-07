---
name: paperclip-manage-prompts
description: >
  Manage agent system prompts (per-role AGENTS.md content) via Langfuse
  Prompt Management. Use when you need to inspect, version, edit, or
  promote a system prompt; or when hiring a new agent role and you need
  to register its system prompt in Langfuse first.
---

# Paperclip Manage Prompts Skill

Use this skill when:

- You're asked to **edit** a system prompt for an existing agent role
  (e.g. "rewrite the engineer system prompt to forbid touching payments/")
- You're **hiring a new role** and need a fresh system prompt
- You need to **review** the version history of an agent's system prompt
- You need to **promote** a tested prompt version to production

The canonical store is the self-hosted Langfuse server at
`http://langfuse-web:3000` (Tailscale: `http://100.125.53.66:3002`).
Prompts are named `agent/{role}` (e.g. `agent/engineer`,
`agent/default`, `agent/ceo`). Labels track lifecycle:

- `staging` — newly drafted, awaiting eval
- `production` — currently used by Paperclip agents at runtime

## Preconditions

You need:

- Langfuse public + secret keys (loaded from server env: `PAPERCLIP_LANGFUSE_PUBLIC_KEY` / `PAPERCLIP_LANGFUSE_SECRET_KEY`)
- For promotion to `production`: confirm eval scores are green via
  `pnpm evals:langfuse` first (regression budget enforced)

If keys are not in the environment, ask Anan / the board to provide them.

## Workflow

### 1. Confirm what role you're working with

Examples of role names: `default`, `ceo`, `engineer`, `pm`. The Langfuse
prompt name is always `agent/{role}`. If unsure, list current prompts:

```bash
references/list-prompts.sh
```

### 2. Read current production text

Before editing, fetch the live version so you don't overwrite anything
unintentionally.

```bash
references/get-prompt.sh agent/engineer production
```

### 3. Draft the new text

Edit a local working copy (any path you control, e.g. `/tmp/edit-engineer.md`).
Keep changes scoped — Paperclip's eval lane scores governance, progress,
tool-correctness, and tone. A change that lifts one but tanks another
will get blocked by the regression gate.

### 4. Save as `staging`

```bash
references/create-prompt-version.sh agent/engineer /tmp/edit-engineer.md "explain change in one line"
```

This creates a NEW immutable version with the `staging` label. Existing
production traffic is unaffected — it still uses the prior `production`-
labeled version.

### 5. Run evals against staging

From the repo root:

```bash
PAPERCLIP_EVAL_PROMPT_LABEL=staging pnpm evals:langfuse
```

Read the per-judge averages and compare to the baseline shown in the
output. If any dimension regresses beyond budget OR governance drops
below the absolute floor, the run exits non-zero. Diagnose, edit, and
re-stage before promoting.

### 6. Promote to production

Only after green evals:

```bash
references/promote-prompt.sh agent/engineer
```

This moves the `production` label from the prior version to the latest
`staging` version. Live agent runs pick up the new text within the SDK
cache TTL (~60 seconds, no container restart).

### 7. Hiring a new role

If you're creating a NEW agent role that doesn't exist yet:

1. Draft the system prompt in `/tmp/agent-{role}.md`.
2. `references/create-prompt-version.sh agent/{role} /tmp/agent-{role}.md "initial prompt for {role}"` — creates v1 with `staging` label.
3. Run evals if you have a relevant dataset; otherwise promote with care.
4. `references/promote-prompt.sh agent/{role}` to label as `production`.
5. Use the existing `paperclip-create-agent` skill to register the agent
   record itself in Paperclip. Future Phase 4b will let the agent read
   from Langfuse at runtime; for now the disk `AGENTS.md` is still the
   runtime source — sync via `pnpm prompts:migrate-langfuse` to keep
   them in step.

## Rollback

If a promotion was a mistake, re-promote the prior version:

```bash
references/list-prompts.sh agent/engineer
# Find the prior version number, then:
references/promote-prompt.sh agent/engineer --version 7
```

## Auditing

All changes leave a trail in Langfuse (commit message, timestamp, who
made the change). Browse via the Tailscale UI:
`http://100.125.53.66:3002/project/paperclip/prompts/agent/{role}`
