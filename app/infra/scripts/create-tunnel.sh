#!/usr/bin/env bash
# Create (idempotently) the Cloudflare Tunnel for Canvas via the API, wire its
# ingress + DNS, fetch the connector token, and configure cloudflared on the box
# (by calling push-tunnel-token.sh). Headless — no dashboard, no browser.
#
# Needs a Cloudflare API token scoped:
#   Account → Cloudflare Tunnel : Edit
#   Zone    → DNS               : Edit   ("Edit zone DNS" template includes Zone:Read)
# for the 21xventures.com zone.
#
# Provide the token WITHOUT pasting it into chat:
#   in your own terminal:  umask 077; printf %s 'cf_token_here' > ~/.cf-canvas-token
# then run this script. It reads ~/.cf-canvas-token (or $CLOUDFLARE_API_TOKEN).
# Revoke the token afterwards if it was a one-off.
#
# Cut over in two steps to avoid touching prod DNS before the box is verified:
#   1. First run with a staging host:
#        CANVAS_HOSTNAME=canvas-staging.21xventures.com ./scripts/create-tunnel.sh
#      verify the app end-to-end, THEN
#   2. Re-run with the real host to flip prod:
#        CANVAS_HOSTNAME=canvas.21xventures.com ./scripts/create-tunnel.sh
#      (same tunnel; this just repoints the ingress + DNS at the prod hostname).
set -euo pipefail
INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$INFRA"

ZONE_NAME="${ZONE_NAME:-21xventures.com}"
HOSTNAME="${CANVAS_HOSTNAME:-canvas.21xventures.com}"
TUNNEL_NAME="${TUNNEL_NAME:-canvas}"
SERVICE="${CANVAS_SERVICE:-http://localhost:3001}"

TOKEN="${CLOUDFLARE_API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$HOME/.cf-canvas-token" ]; then TOKEN="$(tr -d '[:space:]' < "$HOME/.cf-canvas-token")"; fi
if [ -z "$TOKEN" ]; then echo "❌ no CLOUDFLARE_API_TOKEN env and no ~/.cf-canvas-token file" >&2; exit 1; fi

API=https://api.cloudflare.com/client/v4
A=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
# tiny JSON field extractor: pj '<python expr over d>'
pj() { python3 -c 'import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))' "$1"; }

echo "→ verifying token…"
curl -s "${A[@]}" "$API/user/tokens/verify" | pj 'd.get("result",{}).get("status","?") if d.get("success") else "INVALID: "+str(d.get("errors"))'

echo "→ resolving zone ${ZONE_NAME} …"
ZJSON="$(curl -s "${A[@]}" "$API/zones?name=$ZONE_NAME")"
ZONE_ID="$(printf '%s' "$ZJSON" | pj 'd["result"][0]["id"] if d.get("result") else ""')"
ACCOUNT_ID="${ACCOUNT_ID:-$(printf '%s' "$ZJSON" | pj 'd["result"][0]["account"]["id"] if d.get("result") else ""')}"
if [ -z "$ZONE_ID" ]; then echo "❌ zone $ZONE_NAME not found / token lacks Zone:Read. Response: $ZJSON" >&2; exit 1; fi
if [ -z "$ACCOUNT_ID" ]; then echo "❌ no account id (pass ACCOUNT_ID=… or grant Zone:Read). Response: $ZJSON" >&2; exit 1; fi
echo "  zone=$ZONE_ID account=$ACCOUNT_ID"

echo "→ finding or creating tunnel '$TUNNEL_NAME'…"
TJSON="$(curl -s "${A[@]}" "$API/accounts/$ACCOUNT_ID/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false")"
TUNNEL_ID="$(printf '%s' "$TJSON" | pj '(d.get("result") or [{}])[0].get("id","") if d.get("result") else ""')"
if [ -z "$TUNNEL_ID" ]; then
  CJSON="$(curl -s "${A[@]}" -X POST "$API/accounts/$ACCOUNT_ID/cfd_tunnel" --data "{\"name\":\"$TUNNEL_NAME\",\"config_src\":\"cloudflare\"}")"
  TUNNEL_ID="$(printf '%s' "$CJSON" | pj 'd.get("result",{}).get("id","")')"
  if [ -z "$TUNNEL_ID" ]; then echo "❌ tunnel create failed: $CJSON" >&2; exit 1; fi
  echo "  created tunnel $TUNNEL_ID"
else
  echo "  reusing existing tunnel $TUNNEL_ID"
fi

# pass/fail gate: exit the script (don't just print ❌ and march to the success
# banner) when Cloudflare reports the call failed.
ok_or_die() { printf '%s' "$1" | python3 -c 'import sys,json;sys.exit(0 if json.load(sys.stdin).get("success") else 1)' && echo "  ok" || { echo "❌ $2: $1" >&2; exit 1; }; }

# httpHostHeader: force cloudflared to send the public Host to the origin.
# Without it, cloudflared rewrites Host to the service's `localhost:3001`, so
# Next's `request.url` resolves to https://localhost:3001 and every absolute
# URL the app builds (import-route 303s, auth/callback `url.origin`, invite-
# email links) points at the wrong origin — the deck-import POST then trips the
# app's `form-action 'self'` CSP on its cross-origin redirect. Pinning the Host
# to $HOSTNAME makes request.url the real public origin again.
echo "→ setting ingress: $HOSTNAME → $SERVICE (Host pinned to $HOSTNAME)…"
ING="$(curl -s "${A[@]}" -X PUT "$API/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  --data "{\"config\":{\"ingress\":[{\"hostname\":\"$HOSTNAME\",\"service\":\"$SERVICE\",\"originRequest\":{\"httpHostHeader\":\"$HOSTNAME\"}},{\"service\":\"http_status:404\"}]}}")"
ok_or_die "$ING" "ingress config failed"

echo "→ DNS CNAME $HOSTNAME → $TUNNEL_ID.cfargotunnel.com (proxied)…"
CONTENT="$TUNNEL_ID.cfargotunnel.com"
REC="$(curl -s "${A[@]}" "$API/zones/$ZONE_ID/dns_records?type=CNAME&name=$HOSTNAME")"
REC_ID="$(printf '%s' "$REC" | pj '(d.get("result") or [{}])[0].get("id","") if d.get("result") else ""')"
BODY="{\"type\":\"CNAME\",\"name\":\"$HOSTNAME\",\"content\":\"$CONTENT\",\"proxied\":true}"
if [ -z "$REC_ID" ]; then
  DNS="$(curl -s "${A[@]}" -X POST "$API/zones/$ZONE_ID/dns_records" --data "$BODY")"
else
  DNS="$(curl -s "${A[@]}" -X PUT "$API/zones/$ZONE_ID/dns_records/$REC_ID" --data "$BODY")"
fi
ok_or_die "$DNS" "dns record failed"

echo "→ fetching connector token…"
TRESP="$(curl -s "${A[@]}" "$API/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token")"
CONNECTOR_TOKEN="$(printf '%s' "$TRESP" | pj 'd.get("result","") if isinstance(d.get("result"),str) else ""')"
if [ -z "$CONNECTOR_TOKEN" ]; then echo "❌ could not fetch connector token: $TRESP" >&2; exit 1; fi
echo "  got connector token (length ${#CONNECTOR_TOKEN})"

echo "→ handing off to the box (SSM + cloudflared service install)…"
./scripts/push-tunnel-token.sh "$CONNECTOR_TOKEN"

echo
echo "Tunnel + DNS done. DNS may take ~30-60s to propagate, then:"
echo "  curl -s https://$HOSTNAME/api/health   # -> {\"ok\":true}"
