#!/usr/bin/env bash
#
# App-side provisioning for games-games-games.
#
# The backing resources — the R2 bucket (ggg-rulebooks), the D1 database (ggg-db),
# and the Vectorize index (ggg-rules-index) — are owned by the central Cloudflare
# Terraform repo. Provision them THERE first:
#
#     cd ../jasonm4130-cf && make plan && make apply
#
# Then this script does the app-side steps: resolve the D1 database id, wire it into
# wrangler.jsonc, and apply the D1 schema migration. Requires `wrangler login`
# (or CLOUDFLARE_API_TOKEN) and the resources to already exist. See docs/adr/0003.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

d1_database="${D1_DATABASE:-ggg-db}"

echo "==> resolving the ${d1_database} database id"
d1_id="$(pnpm -s wrangler d1 list --json 2>/dev/null |
  python3 -c "import sys,json; print(next((d['uuid'] for d in json.load(sys.stdin) if d.get('name')=='${d1_database}'), ''))" 2>/dev/null || true)"

if [ -z "$d1_id" ]; then
  echo "Could not find '${d1_database}'. Provision the backing resources first:"
  echo "    cd ../jasonm4130-cf && make apply"
  exit 1
fi

echo "==> wiring database_id into wrangler.jsonc (${d1_id})"
if grep -q "REPLACE_WITH_TERRAFORM_OUTPUT" wrangler.jsonc; then
  tmp="$(mktemp)"
  sed "s/REPLACE_WITH_TERRAFORM_OUTPUT/${d1_id}/" wrangler.jsonc >"$tmp" && mv "$tmp" wrangler.jsonc
  echo "    set database_id"
else
  echo "    placeholder already replaced — leaving wrangler.jsonc as-is"
fi

echo "==> applying the D1 schema migration (remote)"
pnpm wrangler d1 migrations apply "$d1_database" --remote

echo
echo "Done. Deploy with:  pnpm deploy"
