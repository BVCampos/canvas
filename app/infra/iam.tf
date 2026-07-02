# ── Instance role: SSM shell + CloudWatch logs + S3 read + env/tunnel secrets ─
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${var.project}-ec2"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

# SSM Session Manager (shell + send-command) — replaces SSH entirely.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# CloudWatch agent: ship the app log to the log group.
resource "aws_iam_role_policy_attachment" "cw_agent" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# App-specific: read the env + tunnel SecureStrings, decrypt them, pull code from S3.
data "aws_iam_policy_document" "app" {
  statement {
    sid       = "ReadSecrets"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.env.arn, aws_ssm_parameter.tunnel_token.arn]
  }

  statement {
    sid       = "DecryptSsmSecureString"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "ReadDeployArtifacts"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.deploy.arn}/*"]
  }

  statement {
    sid       = "ListDeployBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.deploy.arn]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "${var.project}-app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${var.project}-ec2"
  role = aws_iam_role.app.name
}

# ── GitHub Actions OIDC: CI assumes a role with NO static keys ────────────────
# AWS allows only ONE OIDC provider per URL per account. If another 21x repo
# already created it, set create_github_oidc_provider=false and pass its ARN.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS no longer verifies OIDC thumbprints for IAM federation, but the resource
  # still requires the field. These are GitHub's published thumbprints.
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.existing_github_oidc_arn
}

data "aws_iam_policy_document" "ci_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only pushes to the prod ref of this repo can assume the role.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:${var.github_deploy_ref}"]
    }
  }
}

resource "aws_iam_role" "ci_deploy" {
  name               = "${var.project}-ci-deploy"
  assume_role_policy = data.aws_iam_policy_document.ci_assume.json
}

# CI can: put the artifact in S3, then trigger canvas-pull on the box via SSM
# RunShellScript and read the result. Nothing else.
data "aws_iam_policy_document" "ci_deploy" {
  statement {
    sid       = "PutArtifact"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.deploy.arn}/app.tar.gz"]
  }

  statement {
    sid     = "SendDeployCommand"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.app.arn,
      "arn:aws:ssm:${var.region}::document/AWS-RunShellScript",
    ]
  }

  statement {
    sid       = "ReadCommandResult"
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ci_deploy" {
  name   = "${var.project}-ci-deploy"
  role   = aws_iam_role.ci_deploy.id
  policy = data.aws_iam_policy_document.ci_deploy.json
}
