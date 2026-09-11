#!/usr/bin/env bash
# One-time setup of the Hoodbook API on a fresh Ubuntu/Debian VPS. Run as root, from a clone or from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/giupy997/hoodbook/main/deploy/setup.sh \
#     | DOMAIN=api.hoodbook.example SITE_URL=https://hoodbook.example bash
# DOMAIN is the API host and must already point (A record) to this server so Caddy can get a certificate.
# SITE_URL is the website on Netlify; leave it out to serve the pages from this server too.
# Without DOMAIN everything is served over plain HTTP on the server's IP, for a first test.
# Safe to run again: existing .env and database are kept.
set -euo pipefail

REPO="${REPO:-https://github.com/giupy997/hoodbook.git}"
APP_DIR=/opt/hoodbook
APP_USER=hoodbook
APP_HOME=/home/$APP_USER
DOMAIN="${DOMAIN:-}"
SITE_URL="${SITE_URL:-}"

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo -i)"; exit 1; }
as_app() { runuser -u "$APP_USER" -- env HOME="$APP_HOME" bash -c "$1"; }

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl unzip sqlite3 ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "==> user and bun"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
as_app '[ -x ~/.bun/bin/bun ] || curl -fsSL https://bun.sh/install | bash >/dev/null'

echo "==> code"
if [ -d "$APP_DIR/.git" ]; then
  as_app "git -C $APP_DIR pull --ff-only"
else
  install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
  as_app "git clone $REPO $APP_DIR"
fi
as_app "cd $APP_DIR && ~/.bun/bin/bun install --production >/dev/null"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_DIR/data" "$APP_DIR/backups"

echo "==> .env"
if [ ! -f "$APP_DIR/.env" ]; then
  if [ -n "$DOMAIN" ]; then
    BASE="https://$DOMAIN"
  else
    BASE="http://$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1); exit}')"
  fi
  sed -e "s#^BASE_URL=.*#BASE_URL=$BASE#" \
      -e "s#^SITE_URL=.*#SITE_URL=$SITE_URL#" \
      -e "s#^HOST=.*#HOST=127.0.0.1#" \
      -e "s#^TRUST_PROXY=.*#TRUST_PROXY=1#" \
      -e "s#^DB_PATH=.*#DB_PATH=$APP_DIR/data/hoodbook.db#" \
      "$APP_DIR/.env.example" > "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "    created with BASE_URL=$BASE"
else
  echo "    kept the existing $APP_DIR/.env"
fi

echo "==> service"
install -m 644 "$APP_DIR/deploy/hoodbook.service" /etc/systemd/system/hoodbook.service
systemctl daemon-reload
systemctl enable --now hoodbook >/dev/null
systemctl restart hoodbook

echo "==> caddy"
# Caddy sets X-Forwarded-For itself and ignores what clients send, which is what TRUST_PROXY=1 relies on.
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN:-:80} {
	reverse_proxy 127.0.0.1:8787
}
EOF
systemctl reload caddy || systemctl restart caddy

echo "==> daily database backup (14 kept)"
cat > /etc/cron.daily/hoodbook-backup <<EOF
#!/bin/sh
runuser -u $APP_USER -- sqlite3 $APP_DIR/data/hoodbook.db ".backup '$APP_DIR/backups/hoodbook-\$(date +%F).db'"
find $APP_DIR/backups -name 'hoodbook-*.db' -mtime +14 -delete
EOF
chmod 755 /etc/cron.daily/hoodbook-backup

sleep 2
if curl -fsS http://127.0.0.1:8787/api/v1/stats >/dev/null; then
  echo "==> Hoodbook is running: $(grep '^BASE_URL=' "$APP_DIR/.env" | cut -d= -f2)"
else
  echo "==> Hoodbook did not answer yet, check: journalctl -u hoodbook -n 50"
fi
echo "Firewall: only ports 22, 80 and 443 need to be open (check your SSH port before enabling ufw)."
