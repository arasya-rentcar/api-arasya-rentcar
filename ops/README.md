# Ops: API and dashboard on the VPS

Everything needed to rebuild the server lives here, so it never depends on one machine.
The database and file storage are on Supabase, so a new VPS holds no data: only code,
two env files, nginx and pm2.

| What | Where on the VPS |
|---|---|
| Git clones (source of releases) | `/opt/arasya/src/api-arasya-rentcar`, `/opt/arasya/src/dashboard-arasya-rentcar` |
| Releases, live symlink | `/var/www/<repo>/releases/<time>-<sha>`, `/var/www/<repo>/current` |
| Env files (kept across releases) | `/var/www/api-arasya-rentcar/shared/.env`, `/var/www/dashboard-arasya-rentcar/shared/.env.production` |
| Processes | pm2 `api-arasya-rentcar` (port from `.env`, 4000) and `web-arasya-rentcar` (3000) |
| nginx | `api.haikuy.com` → 4000, `dashboard.haikuy.com` → 3000 (`ops/nginx/`) |

## New VPS, step by step

1. **DNS:** point `api.haikuy.com` and `dashboard.haikuy.com` (A records) at the new IP.
2. **Repo access for the VPS** (the repos are private). As root on the VPS:
   ```bash
   apt-get update && apt-get install -y git
   ssh-keygen -t ed25519 -f ~/.ssh/arasya_api -N ""
   ssh-keygen -t ed25519 -f ~/.ssh/arasya_dashboard -N ""
   cat ~/.ssh/arasya_api.pub ~/.ssh/arasya_dashboard.pub
   ```
   Add each public key as a read-only **Deploy key** in its repo (GitHub → repo → Settings → Deploy keys →
   Add deploy key; `arasya_api.pub` in `api-arasya-rentcar`, `arasya_dashboard.pub` in
   `dashboard-arasya-rentcar`). Then add to `~/.ssh/config`:
   ```
   Host github-api
     HostName github.com
     IdentityFile ~/.ssh/arasya_api
   Host github-dashboard
     HostName github.com
     IdentityFile ~/.ssh/arasya_dashboard
   ```
   and clone:
   ```bash
   mkdir -p /opt/arasya/src
   git clone git@github-api:arasya-rentcar/api-arasya-rentcar.git /opt/arasya/src/api-arasya-rentcar
   git clone git@github-dashboard:arasya-rentcar/dashboard-arasya-rentcar.git /opt/arasya/src/dashboard-arasya-rentcar
   ```
3. **Base setup:** `bash /opt/arasya/src/api-arasya-rentcar/ops/setup-vps.sh`. Installs Node 22, pm2 (starts
   on boot), nginx, certbot, firewall (22/80/443), 2 GB swap, the directories and the nginx sites.
4. **Env files:** copy `ops/api.env.template` to `/var/www/api-arasya-rentcar/shared/.env` and
   `ops/dashboard.env.template` to `/var/www/dashboard-arasya-rentcar/shared/.env.production`, fill them in
   (see "Env values"), `chmod 600` both.
5. **First deploy:**
   ```bash
   /opt/arasya/src/api-arasya-rentcar/ops/deploy.sh api
   /opt/arasya/src/api-arasya-rentcar/ops/deploy.sh dashboard
   pm2 ls
   ```
6. **HTTPS:** `certbot --nginx -d api.haikuy.com -d dashboard.haikuy.com`, then `certbot renew --dry-run`.
7. **GitHub Actions deploys** (both repos → Settings → Secrets and variables → Actions):
   make a key for Actions on your own computer (`ssh-keygen -t ed25519 -f arasya_actions -N ""`), append
   `arasya_actions.pub` to `/root/.ssh/authorized_keys` on the VPS, and set `SSH_HOST` (VPS IP),
   `SSH_USER` (`root`), `SSH_PORT` (`22`), `SSH_DEPLOY_KEY` (the private key file's content).
   Then run "Deploy API" and "Deploy Dashboard" from the Actions tab once; both must be green.
8. **Check:** run the "API smoke test" workflow; log in to the dashboard; driver app login and a photo
   upload; a test booking on the website appears under Lead Website.

## Env values

| Variable | Where to get it |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | Supabase → project → **Connect** → Session pooler. Password unknown → Project Settings → Database → Reset password (nothing else uses it except the keep-alive login, which has its own). |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API (Project URL, `service_role` key). |
| `JWT_SECRET` | `openssl rand -hex 32`. A new value logs every admin and driver out once; they log in again. |
| `BOT_INTERNAL_TOKEN` | `openssl rand -hex 32` (required in production; the bot is retired). |
| `GA4_MEASUREMENT_ID`, `GA4_API_SECRET` | Google Analytics → Admin → Data streams → web stream → Measurement ID; Measurement Protocol API secrets → Create. |
| `WEB_DEPLOY_HOOK_URL` | Vercel → `arasya-web` → Settings → Git → Deploy Hooks → create one for `main`. Optional. |
| `CORS_ORIGINS` | `https://dashboard.haikuy.com`, plus the Vercel copy's URL if admins use it. |

## Everyday

- Deploys run from GitHub Actions on push to `main` (`deploy.yml` in each repo): they sync the clones and
  run `ops/deploy.sh` with `GIT_SYNC=1`.
- By hand: `GIT_SYNC=1 /opt/arasya/src/api-arasya-rentcar/ops/deploy.sh api|dashboard`.
- Undo: `/opt/arasya/src/api-arasya-rentcar/ops/deploy.sh rollback api|dashboard` (migrations stay applied;
  they are additive only).
- A release goes live only after it builds, and stays live only if it answers its health check
  (`/health` for the API, `/` for the dashboard); otherwise the previous release comes back. The last 5
  releases are kept.
- Logs: `pm2 logs api-arasya-rentcar`, `pm2 logs web-arasya-rentcar`.
