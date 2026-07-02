#!/usr/bin/env bash
# Upload the app .env to the SSM SecureString the box reads at deploy time.
# Re-run any time you rotate the Supabase keys, then ./deploy.sh (or restart) to
# pick it up. The file should contain the 4 vars from app/.env.example:
#   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
#   SUPABASE_SECRET_KEY, NEXT_PUBLIC_APP_URL (= https://canvas.21xventures.com)
# Usage: ./scripts/push-secrets.sh [path-to-env-file]   (default: ../.env.production)
set -euo pipefail
INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$INFRA/../.env.production}"
cd "$INFRA"

PARAM="$(terraform output -raw env_param)"
REGION="$(terraform output -raw region)"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ env file not found: $ENV_FILE" >&2
  exit 1
fi

echo "→ Uploading $ENV_FILE to SSM $PARAM ($REGION)…"
aws ssm put-parameter \
  --name "$PARAM" \
  --type SecureString \
  --overwrite \
  --value "$(cat "$ENV_FILE")" \
  --region "$REGION" >/dev/null

echo "✅ Secrets uploaded. Run ./scripts/deploy.sh to roll them out."
