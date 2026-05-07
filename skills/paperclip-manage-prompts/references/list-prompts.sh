#!/usr/bin/env bash
# List Langfuse prompts (or all versions of one prompt if a name is passed).
#
# Usage:
#   list-prompts.sh                 # list all prompts
#   list-prompts.sh agent/engineer  # show production version metadata
set -euo pipefail

HOST="${PAPERCLIP_LANGFUSE_HOST:?set PAPERCLIP_LANGFUSE_HOST}"
PK="${PAPERCLIP_LANGFUSE_PUBLIC_KEY:?set PAPERCLIP_LANGFUSE_PUBLIC_KEY}"
SK="${PAPERCLIP_LANGFUSE_SECRET_KEY:?set PAPERCLIP_LANGFUSE_SECRET_KEY}"

if [ $# -eq 0 ]; then
  curl -sS -u "${PK}:${SK}" "${HOST%/}/api/public/v2/prompts?limit=100" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for p in d.get('data', []):
    print('%-30s  versions=%s  labels=%s' % (p['name'], p['versions'], p['labels']))
"
else
  NAME="$1"
  curl -sS -u "${PK}:${SK}" "${HOST%/}/api/public/v2/prompts/$(printf %s "$NAME" | sed 's:/:%2F:g')?label=production" \
    | python3 -m json.tool
fi
