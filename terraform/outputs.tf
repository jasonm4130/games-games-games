output "r2_bucket_name" {
  description = "Wire into wrangler.jsonc r2_buckets[].bucket_name."
  value       = cloudflare_r2_bucket.rulebooks.name
}

output "d1_database_name" {
  description = "Wire into wrangler.jsonc d1_databases[].database_name."
  value       = cloudflare_d1_database.db.name
}

output "d1_database_id" {
  description = "Wire into wrangler.jsonc d1_databases[].database_id."
  value       = cloudflare_d1_database.db.id
}
