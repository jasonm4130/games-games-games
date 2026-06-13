---
status: accepted
---

# Provisioning split: central Terraform owns R2/D1/Vectorize, wrangler owns the Worker

This app's account-level backing resources are **not** defined in this repo. They live in
the central Cloudflare Terraform repo (`../jasonm4130-cf`), which is the single source of
truth for all account/zone infrastructure on the `jasonm4130` account.

| Resource | Owner | How |
| --- | --- | --- |
| R2 bucket (`ggg-rulebooks`) | **central Terraform repo** | `cloudflare_r2_bucket` in `r2.tf` |
| D1 database (`ggg-db`) | **central Terraform repo** | `cloudflare_d1_database` in `workers.tf`; schema via `wrangler d1 migrations apply` |
| Vectorize index (`ggg-rules-index`) | **central Terraform repo** | `restful_resource` (magodo/restful stopgap) in `workers.tf` |
| Worker + Durable Object + bindings | **this repo (wrangler)** | `wrangler.jsonc` + `wrangler deploy` |
| Workers AI (`AI`) | neither | account-level, binding only |

**Why split this way:**

- The central repo already owns all account-level Cloudflare resources. Duplicating them in
  a per-app `terraform/` dir would mean two tools managing the same account and inevitable
  drift. An earlier version of this repo had a local `terraform/` module — it was removed in
  favour of the central repo.
- **Vectorize** has no native resource in the official `cloudflare/cloudflare` v5 provider,
  but the central repo manages it anyway via the `magodo/restful` stopgap (the same pattern
  as its existing `coach-memory` index). So Vectorize *is* Terraform-managed — just not
  through a native resource. (This corrects this ADR's original framing, which said
  Vectorize had to be created by wrangler.)
- The **Durable Object** behind the Agents SDK uses `wrangler.jsonc` `migrations`
  (`new_sqlite_classes`), which has no Terraform primitive — so the Worker and its DO stay
  with wrangler.

**Wiring:** `wrangler.jsonc` references the resources by name (R2, Vectorize) and by id
(D1). The D1 `database_id` is produced when Terraform creates the database; resolve it with
`wrangler d1 list` (or `scripts/provision.sh`, which patches `wrangler.jsonc` and applies
the D1 migration).

**Provisioning order:**

1. `cd ../jasonm4130-cf && make plan && make apply` — creates the R2 bucket, D1 database,
   and Vectorize index.
2. `./scripts/provision.sh` (this repo) — wires the D1 id into `wrangler.jsonc` and applies
   the schema migration.
3. `pnpm deploy`.

**Auth:** the central repo uses an account-scoped `CLOUDFLARE_API_TOKEN` (R2 Edit, D1 Edit,
Vectorize Edit, Account Settings Read), injected through 1Password by its `make` targets.
That token is for provisioning only — `pnpm deploy` from this repo needs a token with
**Workers Scripts Edit** as well. All resources are account-level; no `zone_id` is needed.
