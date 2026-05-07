#!/usr/bin/env bash
# Move the production label to the latest staging version (or to a
# specific version with --version <n>).
#
# Usage:
#   promote-prompt.sh agent/engineer
#   promote-prompt.sh agent/engineer --version 7
set -euo pipefail

NAME="${1:?usage: promote-prompt.sh <name> [--version <n>]}"
shift
VERSION=""
if [ $# -gt 0 ] && [ "$1" = "--version" ]; then
  VERSION="${2:?--version requires a number}"
fi

export HOST="${PAPERCLIP_LANGFUSE_HOST:?set PAPERCLIP_LANGFUSE_HOST}"
export PK="${PAPERCLIP_LANGFUSE_PUBLIC_KEY:?set PAPERCLIP_LANGFUSE_PUBLIC_KEY}"
export SK="${PAPERCLIP_LANGFUSE_SECRET_KEY:?set PAPERCLIP_LANGFUSE_SECRET_KEY}"
export NAME VERSION

python3 -c "
import json, os, sys, urllib.request, urllib.error, base64
name = os.environ['NAME']
version_arg = os.environ['VERSION']
host = os.environ['HOST'].rstrip('/')
pk = os.environ['PK']
sk = os.environ['SK']
auth = base64.b64encode((pk + ':' + sk).encode()).decode()
hdr = {'Authorization': 'Basic ' + auth}
encoded_name = name.replace('/', '%2F')

if version_arg:
    target_version = int(version_arg)
else:
    url = host + '/api/public/v2/prompts/' + encoded_name + '?label=staging'
    res = urllib.request.urlopen(urllib.request.Request(url, headers=hdr))
    data = json.load(res)
    target_version = data.get('version')
    if target_version is None:
        print('no staging version found', file=sys.stderr); sys.exit(2)

body = json.dumps({'newLabels': ['production']}).encode()
patch_url = host + '/api/public/v2/prompts/' + encoded_name + '/versions/' + str(target_version)
req = urllib.request.Request(patch_url, data=body, method='PATCH',
    headers={'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json'})
try:
    res = urllib.request.urlopen(req)
    print('Promoted ' + name + ' v' + str(target_version) + ' to production')
except urllib.error.HTTPError as e:
    print('error:', e.read().decode(), file=sys.stderr); sys.exit(2)
"
