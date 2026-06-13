#!/usr/bin/env bash
#
# Provision every Cloudflare resource for games-games-games, in one pass:
#   1. Terraform  — R2 bucket + D1 database
#   2. (auto)     — patch the D1 id into wrangler.jsonc
#   3. Wrangler   — Vectorize index (no Terraform resource exists)
#   4. Wrangler   — apply the D1 schema migration (remote)
#
# Requires: terraform, pnpm (provides wrangler), and these env vars:
#   CLOUDFLARE_API_TOKEN   account-scoped: R2 Edit, D1 Edit, Vectorize Edit,
#                          Workers Scripts Edit, Account Settings Read
#   TF_VAR_account_id      your Cloudflare account id
#
# See docs/adr/0003 for why the work is split between Terraform and Wrangler.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (account-scoped) first}"
: "${TF_VAR_account_id:?set TF_VAR_account_id to your Cloudflare account id}"

# Terraform reads the token from TF_VAR_cloudflare_api_token.
export TF_VAR_cloudflare_api_token="${TF_VAR_cloudflare_api_token:-$CLOUDFLARE_API_TOKEN}"

vectorize_index="${VECTORIZE_INDEX:-ggg-rules-index}"
d1_database="${D1_DATABASE:-ggg-db}"

command -v terraform >/dev/null || { echo "terraform not found on PATH"; exit 1; }

echo "==> [1/4] terraform apply — R2 bucket + D1 database"
terraform -chdir=terraform init -input=false
terraform -chdir=terraform apply -auto-approve
d1_id="$(terraform -chdir=terraform output -raw d1_database_id)"

echo "==> [2/4] wire D1 id into wrangler.jsonc"
if grep -q "REPLACE_WITH_TERRAFORM_OUTPUT" wrangler.jsonc; then
  tmp="$(mktemp)"
  sed "s/REPLACE_WITH_TERRAFORM_OUTPUT/${d1_id}/" wrangler.jsonc >"$tmp" && mv "$tmp" wrangler.jsonc
  echo "    set database_id = ${d1_id}"
else
  echo "    placeholder already replaced — leaving wrangler.jsonc as-is"
fi

echo "==> [3/4] wrangler vectorize create — ${vectorize_index} (1024 dims, cosine)"
pnpm wrangler vectorize create "$vectorize_index" --dimensions=1024 --metric=cosine \
  || echo "    (index may already exist — continuing)"

echo "==> [4/4] wrangler d1 migrations apply — ${d1_database} (remote)"
pnpm wrangler d1 migrations apply "$d1_database" --remote

echo
echo "Provisioning complete. Deploy with:  pnpm deploy"
