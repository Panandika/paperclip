#!/usr/bin/env bash
# Fetch the text of a specific prompt at a given label.
#
# Usage:
#   get-prompt.sh agent/engineer production
#   get-prompt.sh agent/ceo staging
set -euo pipefail

NAME="${1:?usage: get-prompt.sh <name> [label]}"
LABEL="${2:-production}"

HOST="${PAPERCLIP_LANGFUSE_HOST:?set PAPERCLIP_LANGFUSE_HOST}"
PK="${PAPERCLIP_LANGFUSE_PUBLIC_KEY:?set PAPERCLIP_LANGFUSE_PUBLIC_KEY}"
SK="${PAPERCLIP_LANGFUSE_SECRET_KEY:?set PAPERCLIP_LANGFUSE_SECRET_KEY}"

curl -sS -u "${PK}:${SK}" \
  "${HOST%/}/api/public/v2/prompts/$(printf %s "$NAME" | sed 's:/:%2F:g')?label=${LABEL}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("prompt",""))'
