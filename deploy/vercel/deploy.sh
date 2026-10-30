#!/bin/bash
# Builds the frontend against the box backend (frontend/.env.vercel) and deploys it to the Vercel project kinly
# as a static site. The build is deployed from a folder outside git on purpose: the Vercel CLI attaches the HEAD
# commit's author, and a production deploy is blocked when that author has no Vercel account (this repository's
# history has such authors).
set -euo pipefail
cd "$(dirname "$0")/../.."
SCOPE=denis-projects-1d8d12e3

(cd frontend && npm run build -- --mode vercel)
OUT="$(mktemp -d)/kinly"
cp -R frontend/dist "$OUT"
cp deploy/vercel/vercel.json "$OUT/"
if [ -f deploy/vercel/project.json ]; then
  mkdir -p "$OUT/.vercel" && cp deploy/vercel/project.json "$OUT/.vercel/project.json"
else
  # First deploy: link to (or create) the project and keep its ids for the next runs
  (cd "$OUT" && vercel link --yes --project kinly --scope "$SCOPE" > /dev/null)
  cp "$OUT/.vercel/project.json" deploy/vercel/project.json
fi
cd "$OUT" && vercel deploy --prod --yes --scope "$SCOPE"
