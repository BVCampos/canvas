# canvas — AWS infra

Hosts the Canvas Next.js app on a single EC2 Graviton box, in the 21x house
style (same shape as `03_agentic-workspace/app/infra` and Tread): Terraform →
EC2 AL2023 arm64 → S3-tarball deploy over SSM → secrets in SSM Parameter Store →
Cloudflare Tunnel for the public edge → SSM Session Manager for access. **The
data layer (Supabase) does not live here and does not move** — only the web app
host changes.

```
Cloudflare (DNS + TLS, canvas.21xventures.com)
   │  cloudflared tunnel (outbound from box; no public ingress)
   ▼
EC2 t4g.small (AL2023 arm64, 2 vCPU / 2 GiB + 4 GiB swap)
   systemd canvas.service → node /opt/canvas/app/server.js  (127.0.0.1:3001)
   /opt/canvas/bin/chrome  (arm64 Chromium for the PDF export route)
   │
   ▼
Supabase 21x-canvas-prod  (UNCHANGED: Postgres + Auth + Realtime + Storage)
```

## What's here

| File | Purpose |
|---|---|
| `versions.tf` | provider + **S3 state backend** (delete the backend block to use local state) |
| `variables.tf` | tunables (instance type, hostname, OIDC repo, alert email) |
| `main.tf` | box, egress-only SG, S3 deploy bucket, SSM params, CloudWatch logs, Route53 health check + alarms + SNS |
| `iam.tf` | instance role + **GitHub OIDC provider + CI deploy role** |
| `user_data.sh.tftpl` | first-boot bootstrap: Node 22, arm64 Chromium, cloudflared, `canvas-pull`, `canvas.service` |
| `outputs.tf` | ids/names the scripts + CI consume |
| `scripts/` | `push-secrets` · `deploy` · `logs` · `shell` · `create-tunnel` · `push-tunnel-token` |

## One-time setup

Prereqs: AWS CLI authed to the target account, Terraform ≥ 1.5, the
`session-manager-plugin` (`brew install --cask session-manager-plugin`), and a
Cloudflare API token scoped `Account → Cloudflare Tunnel: Edit` + `Zone → DNS:
Edit` on `21xventures.com`.

```bash
cd app/infra

# 0. State backend (once per account). Skip if you removed the backend block.
aws s3api create-bucket --bucket 21x-tfstate-<acct> --region us-east-1
aws dynamodb create-table --table-name 21x-tflock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST

# 1. Provision. If the account already has a GitHub OIDC provider, add:
#    -var=create_github_oidc_provider=false -var=existing_github_oidc_arn=<arn>
terraform init -backend-config="bucket=21x-tfstate-<acct>"
terraform apply

# 2. Secrets → SSM. Create app/.env.production with the 4 vars from .env.example
#    (NEXT_PUBLIC_APP_URL = https://canvas.21xventures.com).
./scripts/push-secrets.sh ../.env.production

# 3. First build + deploy (builds the standalone bundle locally, ships it).
./scripts/deploy.sh

# 4. Tunnel — STAGING host first, so prod DNS is untouched until verified.
umask 077; printf %s '<cloudflare_api_token>' > ~/.cf-canvas-token
CANVAS_HOSTNAME=canvas-staging.21xventures.com ./scripts/create-tunnel.sh

# 5. Smoke the staging host end-to-end (see checklist below). Then flip prod:
CANVAS_HOSTNAME=canvas.21xventures.com ./scripts/create-tunnel.sh
```

### Wire up CI (GitHub Actions, OIDC — no static keys)

From `terraform output`, set on the `21xventures/21x-canvas` repo:

- secret `AWS_DEPLOY_ROLE_ARN` = `ci_deploy_role_arn`
- var `AWS_REGION` = `us-east-1`, `AWS_DEPLOY_BUCKET` = `deploy_bucket`, `AWS_INSTANCE_ID` = `instance_id`
- var `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_APP_URL`

After that, every push to `main` builds the standalone bundle, ships it to S3,
and runs `canvas-pull` on the box. PRs build only (no deploy, no preview env).

## Day-to-day

```bash
./scripts/deploy.sh      # manual deploy (CI is the normal path)
./scripts/logs.sh 200    # tail the app log via SSM
./scripts/shell.sh       # interactive shell on the box (SSM)
```

## Cutover from Vercel

1. Stand up the box + tunnel on `canvas-staging.21xventures.com`, smoke it.
2. Repoint **prod**: `CANVAS_HOSTNAME=canvas.21xventures.com ./scripts/create-tunnel.sh`
   (Cloudflare flips the `canvas` CNAME to the tunnel). The domain is unchanged,
   so Supabase Auth redirect URLs and `NEXT_PUBLIC_APP_URL` need no edits.
3. Watch `./scripts/logs.sh` and the CloudWatch alarms. Keep the Vercel project
   up ~1 week as rollback (revert the Cloudflare CNAME to Vercel to undo).
4. Decommission: delete the Vercel project, remove `app/.vercel/`, scrub
   `VERCEL_*` from CI.

## Smoke checklist (run against the staging host)

- `curl -s https://canvas-staging.21xventures.com/api/health` → `{"ok":true}`
- Log in (Supabase auth round-trip)
- Open a deck; the editor preview renders
- **PDF export** a multi-slide deck (exercises the box Chromium — the riskiest bit)
- Import an HTML deck
- MCP: `claude mcp` call against `/api/mcp/<token>`
- Ask-Claude chatbox: the bridge poll/event round-trip works

## Notes & gotchas

- **arm64 Chromium is the top risk.** Chrome-for-Testing has no arm64 Linux
  build and `@sparticuz/chromium` is x86_64-only, so the bootstrap installs
  Chromium via Playwright (arm64 builds) and symlinks it to `/opt/canvas/bin/chrome`,
  which `canvas.service` pins as `CHROMIUM_PATH`. If PDF export 500s, check
  `cat /var/log/canvas-bootstrap.log` on the box (`./scripts/shell.sh`) for the
  Chromium install/resolve lines, and confirm `/opt/canvas/bin/chrome` exists and
  runs (`/opt/canvas/bin/chrome --version`). Missing shared libs are the usual
  cause — add them to the `dnf` list in `user_data.sh.tftpl`.
- **Single box** ⇒ a deploy restarts the service (a few seconds of downtime) and
  is a single point of failure. Acceptable for an internal tool; zero-downtime
  (two boxes behind a Cloudflare load balancer, or blue-green) is a future step.
- **No PR preview environments** (the one Vercel feature that doesn't map). PRs
  build in CI as a check; review locally.
- **Cost** ≈ $18/mo: t4g.small (~$12) + 30 GB gp3 (~$3) + S3/CloudWatch
  (pennies). Egress is Cloudflare-fronted. Supabase billing is unchanged.
