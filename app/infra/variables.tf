variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Name prefix for all resources."
  type        = string
  default     = "canvas"
}

variable "instance_type" {
  # t4g.small = 2 vCPU / 2 GiB — the box that's actually running (this default
  # tracks reality so `terraform plan` doesn't want to resize it). Renders are
  # kept off the request path from OOMing it by: one box-wide render gate, a
  # warm-reused Chromium, scale-1 MCP renders, and inlined+bounded fonts.
  #
  # Sizing notes if you do need to bump it (a resize needs a stop/start):
  #   - RAM headroom: t4g.medium (4 GiB) or t4g.large (8 GiB). Cheap OOM insurance
  #     for large PDF/PPTX exports (they hold every slide JPEG at scale 2).
  #   - More CPU: every t4g up to large is 2 vCPU. Only t4g.xlarge+ (or c7g/m7g)
  #     adds cores — reach for that if renders start starving request traffic.
  #   - t4g is BURSTABLE (CPU credits): sustained 100% CPU can throttle to the
  #     ~20-40% baseline. Prefer c7g/m7g (fixed performance) if rendering ever
  #     becomes sustained rather than bursty.
  description = "EC2 instance type (arm64 / Graviton). Default t4g.small = 2 vCPU / 2 GiB; see comment for the RAM-vs-vCPU-vs-burstable tradeoffs before bumping."
  type        = string
  default     = "t4g.small"
}

variable "root_volume_gb" {
  description = "Root EBS volume size in GiB. Holds the OS, Node, the standalone app bundle, and the installed Chromium (~400 MB)."
  type        = number
  default     = 30
}

variable "env_param_name" {
  description = "SSM SecureString parameter holding the app's .env. Value is set out-of-band (scripts/push-secrets.sh), never in Terraform state."
  type        = string
  default     = "/canvas/env"
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the app log group."
  type        = number
  default     = 30
}

variable "app_port" {
  description = "Loopback port the Next standalone server binds. cloudflared forwards the public hostname here; nothing binds publicly."
  type        = number
  default     = 3001
}

# ── Public edge (Cloudflare Tunnel) ──────────────────────────────────────────
variable "tunnel_param_name" {
  description = "SSM SecureString holding the Cloudflare Tunnel connector token. Set via scripts/create-tunnel.sh / push-tunnel-token.sh, never in Terraform state."
  type        = string
  default     = "/canvas/tunnel-token"
}

variable "public_hostname" {
  description = "The public hostname Cloudflare routes to the tunnel. Use a staging host first (canvas-staging.21xventures.com), then flip canvas.21xventures.com at cutover."
  type        = string
  default     = "canvas.21xventures.com"
}

# ── CI deploy (GitHub Actions OIDC) ──────────────────────────────────────────
variable "github_repo" {
  description = "owner/repo allowed to assume the CI deploy role via OIDC."
  type        = string
  default     = "21xventures/21x-canvas"
}

variable "github_deploy_ref" {
  description = "Git ref allowed to deploy (prod). Only pushes to this ref can assume the CI role."
  type        = string
  default     = "refs/heads/main"
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub Actions OIDC provider. AWS allows only ONE provider per URL per account — set false and pass existing_github_oidc_arn if the account already has one (e.g. another 21x repo created it)."
  type        = bool
  default     = true
}

variable "existing_github_oidc_arn" {
  description = "ARN of an existing GitHub OIDC provider, used when create_github_oidc_provider = false."
  type        = string
  default     = ""
}

# ── Alerting ─────────────────────────────────────────────────────────────────
variable "alert_email" {
  description = "Email for down-alerts (SNS). Empty = topic + alarms exist but nobody is subscribed. Set in terraform.tfvars (gitignored)."
  type        = string
  default     = ""
}
