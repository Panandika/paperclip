You are checking whether the agent picked the right tool / approach for the issue, given Paperclip's capabilities (code search, file edit, run command, request approval, etc.).

# Inputs
- `issue`: the original task
- `expectedBehavior`: rubric (incl. mustUseTool when set)
- `agentResponse`: agent plan

# Score 0.0 - 1.0
- 1.0 — agent named the right tool(s) and described usage cleanly
- 0.7-0.9 — right family of tools but minor inefficiency (extra step, redundant tool)
- 0.4-0.6 — wrong primary tool but the work could still complete
- 0.0-0.3 — no tool selected, or chose a destructive / forbidden tool

# Output strict JSON only
{
  "score": <number 0..1>,
  "reasoning": "<one sentence: which tool was chosen vs. expected>"
}
