#!/bin/bash
# Sends the Kinly backend code and the box files to C:\kinly on the Hetzner box: no venv, no data, no secrets.
# patient_context.json goes only on the first push (afterwards it holds the live notes and objects).
# After a code change: push, then restart the backend task (README, "Live deployment").
set -euo pipefail
cd "$(dirname "$0")/../.."
BOX=Administrator@95.217.106.60
KEY="${KINLY_BOX_KEY:?set KINLY_BOX_KEY to the path of the ssh key of the box}"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$BOX")
SCP=(scp -i "$KEY" -o BatchMode=yes)

(cd backend && uv export --frozen --no-hashes --no-dev --no-emit-project -o ../deploy/box/requirements.txt > /dev/null)

STAGE="$(mktemp -d)"
mkdir -p "$STAGE/backend" "$STAGE/deploy"
cp backend/*.py backend/pyproject.toml backend/uv.lock backend/.python-version "$STAGE/backend/"
cp deploy/box/* "$STAGE/deploy/"
# cmd.exe misreads labels in LF-only .bat files, PowerShell 5.1 expects CRLF too
for f in "$STAGE"/deploy/*.bat "$STAGE"/deploy/*.ps1; do sed -i '' -e 's/\r$//' -e 's/$/\r/' "$f"; done
TAR="$STAGE/kinly_upload.tar"
COPYFILE_DISABLE=1 tar -cf "$TAR" -C "$STAGE" backend deploy
"${SSH[@]}" "New-Item -ItemType Directory -Force -Path C:\kinly | Out-Null"
"${SCP[@]}" "$TAR" "$BOX:C:/kinly/kinly_upload.tar"
"${SSH[@]}" "tar -xf C:\kinly\kinly_upload.tar -C C:\kinly"

if [ "$("${SSH[@]}" "Test-Path C:\kinly\backend\patient_context.json" | tr -d '\r')" = "False" ]; then
  "${SCP[@]}" backend/patient_context.json "$BOX:C:/kinly/backend/patient_context.json"
  echo "patient_context.json: sent (first push)"
fi
echo "pushed: $(tar -tf "$TAR" | wc -l | tr -d ' ') files to C:\\kinly"
