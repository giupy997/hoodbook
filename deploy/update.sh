#!/usr/bin/env bash
# Pull the latest main and restart. Run as root on the server: bash /opt/hoodbook/deploy/update.sh
set -euo pipefail

APP_DIR=/opt/hoodbook
APP_USER=hoodbook

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo -i)"; exit 1; }
runuser -u "$APP_USER" -- env HOME="/home/$APP_USER" bash -c "git -C $APP_DIR pull --ff-only && cd $APP_DIR && ~/.bun/bin/bun install --production >/dev/null && bash scripts/fetch-assets.sh"
echo "HOODBOOK_COMMIT=$(git -c safe.directory=$APP_DIR -C $APP_DIR rev-parse --short HEAD)" > "$APP_DIR/release.env"; chown $APP_USER:$APP_USER "$APP_DIR/release.env"
install -m 644 "$APP_DIR"/deploy/*.service "$APP_DIR"/deploy/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl restart hoodbook
# the agents only restart if they are running; enabling them is a separate, deliberate step
systemctl try-restart memeagent 2>/dev/null || true
systemctl try-restart x402agent 2>/dev/null || true
sleep 2
systemctl --no-pager --lines=5 status hoodbook
