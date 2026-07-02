output "instance_id" {
  description = "EC2 instance id (target for SSM + scripts/deploy.sh)."
  value       = aws_instance.app.id
}

output "instance_arn" {
  value = aws_instance.app.arn
}

output "region" {
  value = var.region
}

output "deploy_bucket" {
  description = "S3 bucket the box pulls app.tar.gz from."
  value       = aws_s3_bucket.deploy.bucket
}

output "env_param" {
  description = "SSM SecureString holding the app .env (set via scripts/push-secrets.sh)."
  value       = aws_ssm_parameter.env.name
}

output "tunnel_param" {
  description = "SSM SecureString holding the Cloudflare Tunnel token (set via scripts/create-tunnel.sh)."
  value       = aws_ssm_parameter.tunnel_token.name
}

output "log_group" {
  value = aws_cloudwatch_log_group.app.name
}

output "public_url" {
  description = "Public URL once the Cloudflare tunnel + DNS for public_hostname exist."
  value       = "https://${var.public_hostname}"
}

output "ci_deploy_role_arn" {
  description = "Set this as the AWS_DEPLOY_ROLE_ARN secret/var in GitHub Actions (.github/workflows/deploy.yml)."
  value       = aws_iam_role.ci_deploy.arn
}

output "next_steps" {
  value = <<-EOT

    1. Push secrets:   ./scripts/push-secrets.sh ../.env.production   (uploads -> SSM)
    2. Build + deploy: ./scripts/deploy.sh                            (build standalone -> S3 -> pull + restart)
    3. Create tunnel:  ./scripts/create-tunnel.sh                     (Cloudflare tunnel + DNS + cloudflared on box)
    4. Verify:         curl -s https://${var.public_hostname}/api/health   # -> {"ok":true}
    Shell on box:      ./scripts/shell.sh        Logs: ./scripts/logs.sh
    CI: set repo secret AWS_DEPLOY_ROLE_ARN = ${aws_iam_role.ci_deploy.arn}
        and repo vars NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / NEXT_PUBLIC_APP_URL.
  EOT
}
