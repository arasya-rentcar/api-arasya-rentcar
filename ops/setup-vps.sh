#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu VPS (22.04/24.04) for the Arasya API
# and dashboard. Safe to run again. Run as root. See ops/README.md for the
# steps before (DNS, deploy keys) and after (env files, first deploy, HTTPS).
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl git nginx certbot python3-certbot-nginx ufw

echo "== Node.js 22"
if ! command -v node >/dev/null || ! node -v | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi
node -v

echo "== pm2"
command -v pm2 >/dev/null || npm install -g pm2
pm2 startup systemd -u root --hp /root >/dev/null
pm2 install pm2-logrotate >/dev/null 2>&1 || true

echo "== swap (the Next.js build needs memory)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== firewall (ssh, http, https)"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status | head -5

echo "== directories"
mkdir -p /opt/arasya/src
for r in api-arasya-rentcar dashboard-arasya-rentcar; do
  mkdir -p "/var/www/$r/releases" "/var/www/$r/shared"
  chmod 700 "/var/www/$r/shared"
done

echo "== nginx sites"
here="$(cd "$(dirname "$0")" && pwd)"
for f in "$here"/nginx/*.conf; do
  cp -n "$f" /etc/nginx/sites-available/ && ln -sfn "/etc/nginx/sites-available/$(basename "$f")" /etc/nginx/sites-enabled/
done
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo
echo "Done. Next: env files in /var/www/<repo>/shared, first deploy, HTTPS (ops/README.md)."
