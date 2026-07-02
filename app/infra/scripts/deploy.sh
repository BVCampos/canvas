#!/usr/bin/env bash
# Build the Next standalone bundle, upload it to S3, and tell the box to pull +
# restart. This is the manual/laptop equivalent of the GitHub Actions deploy
# (.github/workflows/deploy.yml) — use it for a hotfix or when CI is down.
# Idempotent.
set -euo pipefail
INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$(cd "$INFRA/.." && pwd)"

cd "$INFRA"
BUCKET="$(terraform output -raw deploy_bucket)"
INSTANCE="$(terraform output -raw instance_id)"
REGION="$(terraform output -raw region)"

cd "$APP"
# Bake the public env into the client bundle at build time — NEXT_PUBLIC_* are
# inlined by `next build`, and an exported var beats .env.local (which carries a
# localhost APP_URL). Mirrors what CI passes; the runtime secret stays in SSM.
ENVPROD="$APP/.env.production"
if [ -f "$ENVPROD" ]; then
  set -a; eval "$(grep -E '^NEXT_PUBLIC_' "$ENVPROD")"; set +a
  echo "→ build env: NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL:-unset}"
fi
echo "→ npm ci…"
npm ci
echo "→ next build (output: standalone)…"
npm run build

# Next standalone does NOT copy static assets or public/ — assemble them so the
# box's `node server.js` finds them. Layout mirrors what CI ships. (Canvas has no
# public/ dir today; the guard keeps this correct if one is ever added.)
echo "→ Assembling standalone bundle…"
rm -rf .next/standalone/.next/static
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/static
[ -d public ] && { rm -rf .next/standalone/public; cp -r public .next/standalone/public; } || true

TARBALL="$(mktemp -t canvas-app).tar.gz"
tar -czf "$TARBALL" -C .next/standalone .

echo "→ Uploading to s3://$BUCKET/app.tar.gz…"
aws s3 cp "$TARBALL" "s3://$BUCKET/app.tar.gz" --region "$REGION" >/dev/null
rm -f "$TARBALL"

echo "→ Triggering pull + restart on ${INSTANCE}…"
CMD="$(aws ssm send-command \
  --instance-ids "$INSTANCE" \
  --region "$REGION" \
  --document-name AWS-RunShellScript \
  --comment 'canvas deploy' \
  --parameters commands='["/usr/local/bin/canvas-pull"]' \
  --query 'Command.CommandId' --output text)"

echo "  SSM command $CMD — waiting for completion…"
aws ssm wait command-executed --command-id "$CMD" --instance-id "$INSTANCE" --region "$REGION" \
  || echo "  (ssm wait timed out or errored — reading final status directly)"

echo "──────────────── deploy output ─────────────────"
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --region "$REGION" \
  --query 'StandardOutputContent' --output text || true
STATUS="$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --region "$REGION" --query 'Status' --output text 2>/dev/null || echo Unknown)"
echo "─────────────────────────────────────────────────"
echo "Status: $STATUS"
if [ "$STATUS" = "Success" ]; then
  echo "✅ Deployed. Tail logs with: ./scripts/logs.sh"
else
  echo "⚠️  Not 'Success' — check ./scripts/logs.sh and the StandardError above."
fi
