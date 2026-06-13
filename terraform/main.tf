terraform {
  required_version = ">= 1.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.19"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# Rulebook PDFs. Referenced in wrangler.jsonc as the RULEBOOKS binding (by name).
resource "cloudflare_r2_bucket" "rulebooks" {
  account_id = var.account_id
  name       = var.r2_bucket_name
  location   = var.r2_location
}

# Metadata database. Terraform creates the shell; the schema is applied with
# `wrangler d1 migrations apply` (see scripts/provision.sh). Referenced in
# wrangler.jsonc as the DB binding — paste the output id there.
#
# Vectorize and the Worker/Durable Object are intentionally NOT here: the
# provider has no Vectorize resource, and DO migrations have no Terraform
# primitive. Wrangler owns those. See docs/adr/0003.
resource "cloudflare_d1_database" "db" {
  account_id = var.account_id
  name       = var.d1_database_name
}
