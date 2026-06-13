variable "cloudflare_api_token" {
  description = "Account-scoped Cloudflare API token (R2 Edit, D1 Edit, Account Settings Read). Prefer passing via TF_VAR_cloudflare_api_token."
  type        = string
  sensitive   = true
}

variable "account_id" {
  description = "Cloudflare account id."
  type        = string
}

variable "r2_bucket_name" {
  description = "Name of the R2 bucket holding uploaded rulebooks. Must match wrangler.jsonc r2_buckets[].bucket_name."
  type        = string
  default     = "ggg-rulebooks"
}

variable "r2_location" {
  description = "R2 location hint (e.g. WEUR, EEUR, ENAM, WNAM, APAC)."
  type        = string
  default     = "WEUR"
}

variable "d1_database_name" {
  description = "Name of the D1 metadata database. Must match wrangler.jsonc d1_databases[].database_name."
  type        = string
  default     = "ggg-db"
}
