#!/usr/bin/env bash
# AutoCliper — update the VPS to the latest code from GitHub, then restart.
#   bash /opt/autocliper/deploy/update.sh
set -euo pipefail
APP_DIR=/opt/autocliper
cd "$APP_DIR"
git pull --ff-only
pnpm install --frozen-lockfile || pnpm install
pnpm --filter @workspace/ytdlp-ui run build
pnpm --filter @workspace/api-server run build
chown -R autocliper:autocliper "$APP_DIR"
systemctl restart autocliper
sleep 2
systemctl --no-pager --lines=5 status autocliper || true
echo ""
echo "✅ Updated. Health: $(curl -s http://127.0.0.1:3000/api/healthz || echo 'NOT RESPONDING')"
