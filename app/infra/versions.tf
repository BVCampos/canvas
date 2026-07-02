terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.40, < 7.0"
    }
  }

  # State lives in S3 (NOT committed, unlike agentic-workspace's local state).
  # Create the bucket + lock table once, out-of-band, then `terraform init`:
  #   aws s3api create-bucket --bucket 21x-tfstate-<acct> --region us-east-1
  #   aws dynamodb create-table --table-name 21x-tflock \
  #     --attribute-definitions AttributeName=LockID,AttributeType=S \
  #     --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST
  # If you'd rather keep local state like the other 21x stacks, delete this block.
  backend "s3" {
    key            = "canvas/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "21x-tflock"
    encrypt        = true
    # bucket is passed at init: `terraform init -backend-config="bucket=21x-tfstate-<acct>"`
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      project   = var.project
      managedBy = "terraform"
    }
  }
}
