data "aws_caller_identity" "me" {}

# Default VPC + its subnets — the box is outbound-only (cloudflared dials OUT to
# Cloudflare, SSM/CloudWatch reach AWS over egress), so a public subnet with an
# internet gateway is all it needs: no NAT gateway, no load balancer, no inbound.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# Latest Amazon Linux 2023 arm64 AMI (Graviton), matching the 21x house style.
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-arm64"]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  filter {
    name   = "state"
    values = ["available"]
  }
}

# ── Deploy artifact bucket: the box pulls app.tar.gz from here ────────────────
resource "aws_s3_bucket" "deploy" {
  bucket        = "${var.project}-deploy-${data.aws_caller_identity.me.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "deploy" {
  bucket                  = aws_s3_bucket.deploy.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "deploy" {
  bucket = aws_s3_bucket.deploy.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ── Secrets ───────────────────────────────────────────────────────────────────
# One SecureString holds the whole app .env (the 4 vars from app/.env.example).
# Placeholder here so the real Supabase secret never lands in tf state;
# scripts/push-secrets.sh overwrites it from app/.env.production via the CLI.
resource "aws_ssm_parameter" "env" {
  name        = var.env_param_name
  description = "canvas app .env (set via scripts/push-secrets.sh)"
  type        = "SecureString"
  tier        = "Intelligent-Tiering"
  value       = "PLACEHOLDER set via scripts/push-secrets.sh"

  lifecycle {
    ignore_changes = [value]
  }
}

# Cloudflare Tunnel connector token. cloudflared dials OUT to Cloudflare, which
# terminates TLS at the edge and forwards public traffic to localhost:app_port —
# so there is NO public ingress on the SG. Value set via scripts/create-tunnel.sh.
resource "aws_ssm_parameter" "tunnel_token" {
  name        = var.tunnel_param_name
  description = "Cloudflare Tunnel token for canvas (set via scripts/create-tunnel.sh)"
  type        = "SecureString"
  tier        = "Intelligent-Tiering"
  value       = "PLACEHOLDER set via scripts/create-tunnel.sh"

  lifecycle {
    ignore_changes = [value]
  }
}

# ── Logs ──────────────────────────────────────────────────────────────────────
resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.project}/app"
  retention_in_days = var.log_retention_days
}

# ── Security group: egress only, zero inbound ────────────────────────────────
resource "aws_security_group" "app" {
  name        = "${var.project}-app"
  description = "canvas app box: outbound only (cloudflared + Supabase + SSM/CloudWatch). No inbound."
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-app" }
}

# ── The host ──────────────────────────────────────────────────────────────────
resource "aws_instance" "app" {
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnets.default.ids[0]
  vpc_security_group_ids      = [aws_security_group.app.id]
  associate_public_ip_address = true # egress only; no inbound from the internet (SG)
  iam_instance_profile        = aws_iam_instance_profile.app.name

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2 only
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    deploy_bucket = aws_s3_bucket.deploy.bucket
    env_param     = aws_ssm_parameter.env.name
    region        = var.region
    log_group     = aws_cloudwatch_log_group.app.name
    app_port      = var.app_port
  })

  # Note: the Cloudflare tunnel token (aws_ssm_parameter.tunnel_token) is NOT
  # baked into user_data — it's configured out-of-band by scripts/create-tunnel.sh
  # after the box is up, so it isn't passed to the template.

  tags = { Name = var.project }

  # The AMI data source tracks the latest AL2023 release; without this guard a
  # routine `terraform apply` would REPLACE the live instance (and its disk)
  # just because Amazon published a newer image. AMI upgrades are a deliberate
  # operation: remove this line, plan, and migrate intentionally.
  lifecycle {
    ignore_changes = [ami]
  }
}

# ── Alerting: know when canvas is down without a user reporting it first ──────
# Two failure modes, two detectors:
#   1. The box dies  → EC2 StatusCheckFailed alarm.
#   2. The path dies → Route53 health check on the PUBLIC /api/health (exercises
#      Cloudflare edge → tunnel → cloudflared → Next), so a dead tunnel or wedged
#      service alarms even when the instance itself looks healthy.
resource "aws_sns_topic" "alerts" {
  name = "${var.project}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "status_check" {
  alarm_name          = "${var.project}-status-check-failed"
  alarm_description   = "canvas EC2 instance failing status checks (box-level death)."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { InstanceId = aws_instance.app.id }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_route53_health_check" "public_healthz" {
  fqdn              = var.public_hostname
  type              = "HTTPS"
  resource_path     = "/api/health"
  port              = 443
  request_interval  = 30
  failure_threshold = 3

  tags = { Name = "${var.project}-healthz" }
}

# Route53 health-check metrics land in us-east-1 — which is where this stack runs.
resource "aws_cloudwatch_metric_alarm" "public_healthz" {
  alarm_name          = "${var.project}-public-healthz"
  alarm_description   = "Public https://${var.public_hostname}/api/health failing (tunnel or service down)."
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = aws_route53_health_check.public_healthz.id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
