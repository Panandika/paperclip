#!/usr/bin/env bash
# Create a new version of a Langfuse prompt with the staging label.
#
# Usage:
#   create-prompt-version.sh agent/engineer /tmp/edit-engineer.md "rewrite to forbid payments/"
set -euo pipefail

NAME="${1:?usage: create-prompt-version.sh <name> <file> [commit-message]}"
FILE="${2:?usage: create-prompt-version.sh <name> <file> [commit-message]}"
MSG="${3:-no message}"

export HOST="${PAPERCLIP_LANGFUSE_HOST:?set PAPERCLIP_LANGFUSE_HOST}"
export PK="${PAPERCLIP_LANGFUSE_PUBLIC_KEY:?set PAPERCLIP_LANGFUSE_PUBLIC_KEY}"
export SK="${PAPERCLIP_LANGFUSE_SECRET_KEY:?set PAPERCLIP_LANGFUSE_SECRET_KEY}"
export NAME MSG

[ -f "$FILE" ] || { echo "file not found: $FILE" >&2; exit 1; }

cat "$FILE" | python3 -c "
import json, os, sys, urllib.request, urllib.error, base64
host = os.environ['HOST'].rstrip('/')
pk = os.environ['PK']
sk = os.environ['SK']
auth = base64.b64encode((pk + ':' + sk).encode()).decode()
body = json.dumps({
    'name': os.environ['NAME'],
    'type': 'text',
    'prompt': sys.stdin.read(),
    'labels': ['staging'],
    'tags': ['paperclip', 'managed-by-skill'],
    'commitMessage': os.environ['MSG'],
}).encode()
req = urllib.request.Request(
    host + '/api/public/v2/prompts',
    data=body, method='POST',
    headers={'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth},
)
try:
    res = urllib.request.urlopen(req)
    data = json.load(res)
    print('Created ' + str(data.get('name')) + ' version ' + str(data.get('version')) + ' with label staging')
except urllib.error.HTTPError as e:
    print('error:', e.read().decode(), file=sys.stderr); sys.exit(2)
"
