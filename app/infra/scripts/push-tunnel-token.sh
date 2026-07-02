#!/usr/bin/env bash
# Store the Cloudflare Tunnel token in SSM and (re)configure cloudflared on the
# box. Normally called by create-tunnel.sh, but you can run it standalone to
# rotate the token. Mirrors push-secrets.sh: the secret goes into SSM, never tf
# state, and the box fetches it itself (so the raw token never appears in the SSM
# command / CloudTrail).
#
# Usage:
#   ./scripts/push-tunnel-token.sh <TUNNEL_TOKEN>
#   ./scripts/push-tunnel-token.sh -f path/to/token.txt
#   CANVAS_TUNNEL_TOKEN=… ./scripts/push-tunnel-token.sh
set -euo pipefail
INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$INFRA"

TOKEN=""
if [ "${1:-}" = "-f" ] && [ -n "${2:-}" ]; then
  TOKEN="$(tr -d '[:space:]' < "$2")"
elif [ -n "${1:-}" ]; then
  TOKEN="$1"
elif [ -n "${CANVAS_TUNNEL_TOKEN:-}" ]; then
  TOKEN="$CANVAS_TUNNEL_TOKEN"
fi
if [ -z "$TOKEN" ]; then
  echo "❌ no token given. Pass it as an arg, with -f <file>, or set CANVAS_TUNNEL_TOKEN." >&2
  exit 1
fi

PARAM="$(terraform output -raw tunnel_param)"
REGION="$(terraform output -raw region)"
INSTANCE="$(terraform output -raw instance_id)"
PUBURL="$(terraform output -raw public_url)"

echo "→ Storing tunnel token in SSM $PARAM ($REGION)…"
aws ssm put-parameter \
  --name "$PARAM" \
  --type SecureString \
  --overwrite \
  --value "$TOKEN" \
  --region "$REGION" >/dev/null

# ── configure cloudflared on the box (fetches the token from SSM itself) ──────
# Built via a QUOTED heredoc to a temp file (no shell expansion, and no $()
# parser choking on the case statement), then @@PARAM@@ / @@REGION@@ are
# substituted and the whole thing base64'd for the SSM call.
TMPR="$(mktemp)"
cat > "$TMPR" <<'REOF'
set -e
if ! command -v cloudflared >/dev/null 2>&1; then
  dnf install -y https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-aarch64.rpm \
    || { curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared; }
fi
TOKEN=$(aws ssm get-parameter --name "@@PARAM@@" --with-decryption --region "@@REGION@@" --query Parameter.Value --output text)
case "$TOKEN" in PLACEHOLDER*) echo "tunnel token is still the placeholder"; exit 1;; esac
cloudflared service uninstall >/dev/null 2>&1 || true
cloudflared service install "$TOKEN"
systemctl enable --now cloudflared
sleep 4
systemctl is-active cloudflared && echo "cloudflared: active" || { journalctl -u cloudflared --no-pager -n 30; exit 1; }
REOF
B64="$(sed -e "s|@@PARAM@@|$PARAM|g" -e "s|@@REGION@@|$REGION|g" "$TMPR" | base64)"
rm -f "$TMPR"

echo "→ Installing/starting cloudflared on ${INSTANCE} via SSM…"
CMD="$(aws ssm send-command \
  --instance-ids "$INSTANCE" \
  --region "$REGION" \
  --document-name AWS-RunShellScript \
  --comment 'canvas cloudflared setup' \
  --parameters commands="[\"echo $B64 | base64 -d | bash\"]" \
  --query 'Command.CommandId' --output text)"

echo "  SSM command $CMD — waiting…"
aws ssm wait command-executed --command-id "$CMD" --instance-id "$INSTANCE" --region "$REGION" 2>/dev/null || true
echo "──────────────── cloudflared setup output ─────────────────"
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --region "$REGION" --query 'StandardOutputContent' --output text || true
STATUS="$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --region "$REGION" --query 'Status' --output text 2>/dev/null || echo Unknown)"
echo "───────────────────────────────────────────────────────────"
echo "Status: $STATUS"
if [ "$STATUS" = "Success" ]; then
  echo "✅ Tunnel up. Verify:  curl -s $PUBURL/api/health   # -> {\"ok\":true}"
else
  echo "⚠️  Not 'Success' — check the output above (token wrong, or ingress hostname not set)."
fi
