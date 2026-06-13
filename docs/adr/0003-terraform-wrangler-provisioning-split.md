---
status: accepted
---

# Terraform owns R2 + D1; Wrangler owns Vectorize, the Worker, and the Durable Object

Provisioning is split between two tools:

| Resource | Owner |
| --- | --- |
| R2 bucket (`RULEBOOKS`) | **Terraform** — `cloudflare_r2_bucket` |
| D1 database (`DB`) | **Terraform** — `cloudflare_d1_database` (schema applied via `wrangler d1 migrations`) |
| Vectorize index (`RULES_IDX`) | **Wrangler** — `wrangler vectorize create` |
| Worker + Durable Object + bindings | **Wrangler** — `wrangler deploy` + `wrangler.jsonc` |
| Workers AI (`AI`) | neither — account-level, binding only |

**Why this split (and why it's surprising):** a reader will reasonably ask "why is
Vectorize created by wrangler when R2 and D1 are in Terraform?" The answer is a real
constraint, not a preference: the Cloudflare Terraform provider (v5) has **no
`cloudflare_vectorize_index` resource** — Vectorize can only be created via wrangler or
the REST API. Likewise, the Durable Object that backs the Agents SDK uses
`wrangler.jsonc` `migrations` (`new_sqlite_classes`), which has no Terraform primitive, so
the Worker and its DO stay with wrangler.

**Rule to avoid drift:** each resource is managed by exactly one tool. Terraform creates
R2 + D1 and outputs their names/ids; those are referenced (not re-created) in
`wrangler.jsonc`. `terraform apply` runs before the first `wrangler deploy`.
`scripts/provision.sh` runs the Terraform apply and the wrangler-only creates together so
both halves are provisioned in one step.

**Auth:** an account-scoped `CLOUDFLARE_API_TOKEN` (R2 Edit, D1 Edit, Vectorize Edit,
Workers Scripts Edit, Account Settings Read) — not the Global API Key. All resources are
account-level; no `zone_id` is needed.
