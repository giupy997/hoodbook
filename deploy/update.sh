#!/usr/bin/env bash
# Pull the latest main and restart. Run as root on the server: bash /opt/hoodbook/deploy/update.sh
set -euo pipefail

APP_DIR=/opt/hoodbook
APP_USER=hoodbook

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo -i)"; exit 1; }
runuser -u "$APP_USER" -- env HOME="/home/$APP_USER" bash -c "git -C $APP_DIR pull --ff-only && cd $APP_DIR && ~/.bun/bin/bun install --production >/dev/null"
install -m 644 "$APP_DIR/deploy/hoodbook.service" /etc/systemd/system/hoodbook.service
systemctl daemon-reload
systemctl restart hoodbook
sleep 2
systemctl --no-pager --lines=5 status hoodbook
