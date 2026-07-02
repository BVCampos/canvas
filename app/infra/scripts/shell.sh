#!/usr/bin/env bash
# Interactive shell on the box via SSM Session Manager (no SSH, no open ports).
# Requires the AWS session-manager-plugin locally:
#   macOS: brew install --cask session-manager-plugin
# Once in:  sudo journalctl -u canvas -f   OR   tail -f /var/log/canvas/app.log
#           cat /var/log/canvas-bootstrap.log   # for first-boot / Chromium issues
set -euo pipefail
INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$INFRA"
INSTANCE="$(terraform output -raw instance_id)"
REGION="$(terraform output -raw region)"
echo "→ Opening SSM shell on $INSTANCE…"
exec aws ssm start-session --target "$INSTANCE" --region "$REGION"
