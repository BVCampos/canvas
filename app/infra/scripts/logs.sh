#!/usr/bin/env bash
# Dump the last N lines of the app log (default 120) via SSM — no SSH, no
# session-manager-plugin required.
# Usage: ./scripts/logs.sh [lines]
set -euo pipefail
INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$INFRA"
INSTANCE="$(terraform output -raw instance_id)"
REGION="$(terraform output -raw region)"
LINES="${1:-120}"

echo "→ Last $LINES lines of /var/log/canvas/app.log on ${INSTANCE}…"
CMD="$(aws ssm send-command \
  --instance-ids "$INSTANCE" \
  --region "$REGION" \
  --document-name AWS-RunShellScript \
  --parameters commands="[\"tail -n $LINES /var/log/canvas/app.log\"]" \
  --query 'Command.CommandId' --output text)"
aws ssm wait command-executed --command-id "$CMD" --instance-id "$INSTANCE" --region "$REGION" 2>/dev/null || true
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --region "$REGION" \
  --query 'StandardOutputContent' --output text
STATUS="$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --region "$REGION" --query 'Status' --output text 2>/dev/null || echo Unknown)"
[ "$STATUS" = "Success" ] || echo "(ssm command status: $STATUS — empty output above means the tail command did not run, not that the log is empty)"
